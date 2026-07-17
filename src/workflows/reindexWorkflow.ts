import {WorkflowEntrypoint, WorkflowEvent, WorkflowStep} from "cloudflare:workers";
import {FloatplaneCreator, FloatplanePost} from "../types";
import {commas, formatFloatplanePost, proxyFetch, retry} from "../utils";
import {UpdateParams} from "./updateWorkflow";
import {Client} from "@opensearch-project/opensearch";
import {VIDEOS_INDEX_SETTINGS} from "../indexSettings";

export class ReIndexWorkflow extends WorkflowEntrypoint<Env, Params> {
    async run(_: WorkflowEvent<Params>, step: WorkflowStep) {
        const client = new Client({
            node: "https://osearch.ajg0702.us",
            auth: {
                username: this.env.OS_UPDATE_USER,
                password: this.env.OS_UPDATE_PASS
            },
            ssl: {
                rejectUnauthorized: false,
            },
        });

        const newIndex = await step.do("Create new collection", {
            retries: {
                delay: "2 minutes",
                limit: 50
            }
        }, async () => {
            const r = await client.indices.create({
                index: "floatplane_" + Date.now().toString(36),
                body: VIDEOS_INDEX_SETTINGS
            });
            return r.body.index;
        });

        await step.do("Create alias if this is the first run", async () => {
            const exists = await client.indices.existsAlias({name: "floatplane"})
                .then(r => r.body)
                .catch(e => {
                    if(e?.meta?.statusCode === 404) return false;
                    console.log("Error while checking for index alias:", e)
                    throw e;
                });
            if(exists) return "Index/Alias already exists. Not creating a new one.";
            await client.indices.putAlias({
                index: newIndex,
                name: "floatplane"
            })
                .catch(e => {
                    console.log("Error while creating index alias:", e);
                    throw e;
                });
            return "Index created, since one didn't already exist."
        });

        const creators: (FloatplaneCreator & {stats: {posts: number, subscribers: number, channels: {id: string, posts: number}[]}})[] =
            await step.do("Fetch creators", {
                    retries: {
                        delay: "5 minutes",
                        limit: 50
                    }
                }, () =>
                proxyFetch(this.env,
                    "https://www.floatplane.com/api/v3/creator/discover?limit=100&creatorStats=true",
                    {
                        headers: {
                            "User-Agent": "Mozilla/5.0 (compatible; Floatplane-Info-Indexer/1.0.0; +https://floatplane.info/indexer)"
                        }
                    }
                )
                    .then(r => r.json())
                    .then(r => (r as any).creators)
            );


        let ci = 0;
        const creatorPromises = [];
        for (const creator of creators) {
            creatorPromises.push((async () => {
                let i = 0;

                while(true) {
                    let run = false;
                    const num = await step.do(`[${creator.id}] Fetch and Index #${(i+1)} (${commas(i * 19)} - ${commas(((i+1) * 19) - 1)} / ${commas(creator.stats.posts)})`, {
                        retries: {
                            delay: "1 minute",
                            limit: 15
                        }
                    }, async () => {
                        run = true;
                        const videos = await proxyFetch(this.env,
                            // use a slightly lower fetchAfter value in case something gets uploaded while we're scanning
                            `https://www.floatplane.com/api/v3/content/creator?id=${creator.id}&limit=20&fetchAfter=${i * 19}&search=&sort=DESC`,
                            {
                                headers: {
                                    "User-Agent": "Mozilla/5.0 (compatible; Floatplane-Info-Indexer/1.0.0; +https://floatplane.info/indexer)"
                                }
                            }
                        ).then(r => r.json() as Promise<FloatplanePost[]>);
                        if(videos.length === 0) return 0;

                        const documents = await Promise.all(
                            videos.map(v => formatFloatplanePost(v, this.env))
                        );

                        // also upsert them in the current active collection (so any changes show up right away)
                        const currentUpdateP = client.indices.exists({index: "floatplane"})
                            .then(async ar => {
                                if(!ar.body) return;
                                const index = await client.indices.getAlias({name: "floatplane"});
                                if(Object.keys(index.body).includes(newIndex)) return;
                                await client.bulk({
                                    body: documents.map(d => [
                                        {update: {_index: "floatplane", _id: d.id}},
                                        {doc: d, doc_as_upsert: true}
                                    ]).flat(),
                                    refresh: false
                                })
                                    .catch(e => console.warn("Unable to upsert in existing index:", e));
                            })

                        const indexedCount = await retry(() =>
                            client.bulk({
                                body: documents.map(d => [
                                    {update: {_index: newIndex, _id: d.id}},
                                    {doc: d, doc_as_upsert: true}
                                ]).flat(),
                                refresh: false
                            })
                                .then(r => r.body.items.length)
                                .catch(e => {
                                    console.warn("Unable to upsert in new collection:", e);
                                    throw e;
                                })
                        );

                        await currentUpdateP;

                        return indexedCount;
                    });
                    if(run) {
                        // wait random time between 30s and 5 minutes so we aren't spamming floatplane
                        await step.sleep(`Cooldown ${creator.id}-${i}`, `${Math.floor((0.5 + (4.5 * Math.random())) * 60)} seconds`)
                    }
                    if(num === 0) break;
                    i++;
                }
            })());
            await step.sleep(`Initial cooldown ${++ci}`, "5 seconds")
        }
        await Promise.all(creatorPromises);

        await step.do("Update alias to point to new collection", {
            retries: {
                delay: "2 minutes",
                limit: 100
            }
        }, async () => {
            await client.indices.updateAliases({ body: { actions: [
                        { remove: { alias: 'floatplane', index: 'floatplane_*' } },
                        { add: { alias: 'floatplane', index: newIndex } },
                    ] } });
        });

        // in case anything new was added since we started this scan
        await step.do("Start fresh update", {
            retries: {
                delay: "5 seconds",
                limit: 50
            }
        }, async () => {
            await (this.env.UPDATE_WORKFLOW as Workflow<UpdateParams>)
                .create({ params: { count: 20 } });
        })

        const oldIndexes = await step.do("Fetch old collections", {
                retries: {
                    delay: "1 minute",
                    limit: 50
                }
            }, async () => {
                const indices = await client.indices.get({ index: "floatplane_*" })
                    .then(r => Object.keys(r.body))
                    .catch(e => {
                        if(e?.meta?.statusCode === 404) return [];
                        throw e;
                    });
                // The response body keys are the index names
                return indices
                    .filter(i => i.startsWith("floatplane_") && i !== newIndex);
            }
        );

        for (const oldIndex of oldIndexes) {
            if(oldIndex === newIndex) continue;
            await step.do("Delete old index: " + oldIndex, async () => {
                await client.indices.delete({index: oldIndex});
            })
        }

    }
}
import {WorkflowEntrypoint, WorkflowEvent, WorkflowStep} from "cloudflare:workers";
import Typesense from "typesense/src/Typesense";
import {CollectionSchema} from "typesense";
import {FloatplaneCreator, FloatplanePost} from "../types";
import {commas, formatFloatplanePost, proxyFetch, retry} from "../utils";

const schema = (name: string, env: Env) => ({
    name,
    fields: [
        { name: "title", type: "string", stem: true },
        { name: "textMarkdown", type: "string" },
        { name: "timestamp", type: "int32", range_index: true },
        { name: "creator.id", type: "string", facet: true },
        { name: "channel.id", type: "string", facet: true },
        { name: "embedding", type: "float[]", num_dim: 1024 }
    ],
    enable_nested_fields: true
} as CollectionSchema);

export class ReIndexWorkflow extends WorkflowEntrypoint<Env, Params> {
    async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
        const client = new Typesense.Client({
            nodes: [{ host: "search.ajg0702.us", port: 443, protocol: "https" }],
            apiKey: this.env.UPDATE_KEY,
            connectionTimeoutSeconds: 60
        });

        const newCollection = await step.do("Create new collection", async () => {
            return await client.collections()
                .create(
                    schema("floatplane_" + Date.now().toString(36), this.env)
                ).then(c => c.name);
        });

        const creators: (FloatplaneCreator & {stats: {posts: number, subscribers: number, channels: {id: string, posts: number}[]}})[] =
            await step.do("Fetch creators", () =>
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
                    const num = await step.do(`[${creator.id}] Fetch and Index #${(i+1)} (${commas(i * 19)} - ${commas(((i+1) * 19) - 1)} / ${commas(creator.stats.posts)})`, async () => {
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
                        const currentUpdateP = client.collections("floatplane")
                            .documents()
                            .import(documents, { action: "upsert"})
                            .catch(e => console.warn("Unable to upsert in existing collection:", e));

                        const indexedCount = await retry(() =>
                            client.collections(newCollection).documents().import(
                                documents,
                                { action: "upsert" }
                            )
                                .then(r => r.length)
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

        await step.do("Update alias to point to new collection", async () => {
            await client.aliases().upsert("floatplane", { collection_name: newCollection })
        })

        const oldCollections = await step.do("Fetch old collections", () =>
            client.collections().retrieve({exclude_fields: "fields"})
                .then(collections =>
                    collections
                        .filter(c => c.name.startsWith("floatplane_"))
                        .map(c => c.name)
                )
        );

        for (const oldCollection of oldCollections) {
            if(oldCollection === newCollection) continue;
            await step.do("Delete old collection: " + oldCollection, async () => {
                await client.collections(oldCollection).delete();
            })
        }

    }
}
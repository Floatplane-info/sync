import {WorkflowEntrypoint, WorkflowEvent, WorkflowStep} from "cloudflare:workers";
import Typesense from "typesense";
import {commas, formatFloatplanePost, proxyFetch, retry} from "../utils";
import {FloatplanePost} from "../types";

export type UpdateParams = {
    count?: number
}

export class UpdateWorkflow extends WorkflowEntrypoint<Env, UpdateParams> {
    async run(event: WorkflowEvent<UpdateParams>, step: WorkflowStep) {
        const count = event.payload.count ?? 10;

        const client = new Typesense.Client({
            nodes: [{ host: "search.ajg0702.us", port: 443, protocol: "https" }],
            apiKey: this.env.UPDATE_KEY,
            connectionTimeoutSeconds: 60
        });

        const creators = await step.do("Fetch active creators", async () => {

            // we fetch creators from the index to save a floatplane request and easier filter out ppl who havent uploaded recently
            // we filter out ppl who havent uploaded in the past 6 months to helps save requests for inactive creators (which is a bunch)
            const results = await client.collections("floatplane").documents().search({
                q: "*",
                query_by: "title",
                per_page: 1,
                page: 1,
                facet_by: "creator.id",
                max_facet_values: 1000,
                filter_by: "timestamp:>" + Math.round((Date.now() - (6 * 30 * 24 * 60 * 60e3)) / 60e3)
            });
            return results.facet_counts![0]!.counts.map(c => c.value);
        });


        let ci = 0;
        const creatorPromises = [];
        for (const creator of creators) {
            creatorPromises.push((async () => {
                await step.do(`[${creator}] Fetch and Index top ${count}`, async () => {
                    const videos = await proxyFetch(this.env,
                        // use a slightly lower fetchAfter value in case something gets uploaded while we're scanning
                        `https://www.floatplane.com/api/v3/content/creator?id=${creator}&limit=${count}&fetchAfter=0&search=&sort=DESC`,
                        {
                            headers: {
                                "User-Agent": "Mozilla/5.0 (compatible; Floatplane-Info-Indexer/1.0.0; +https://floatplane.info/indexer)"
                            }
                        }
                    ).then(r => r.json() as Promise<FloatplanePost[]>);
                    if(videos.length === 0) return;

                    const documents = await Promise.all(
                        videos.map(v => formatFloatplanePost(v, this.env))
                    );

                    await client.collections("floatplane")
                        .documents()
                        .import(documents, { action: "upsert"})
                        .catch(e => {
                            console.error("Failed to upsert post:", e);
                            throw e;
                        });

                });
            })());
            // 5-10 second cooldown between requests
            await step.sleep(`Initial cooldown ${++ci}`, `${5 + Math.round(5 * Math.random())} seconds`)
        }
        await Promise.all(creatorPromises);


    }
}
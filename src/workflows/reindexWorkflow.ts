import {WorkflowEntrypoint, WorkflowEvent, WorkflowStep} from "cloudflare:workers";
import Typesense from "typesense/src/Typesense";
import {CollectionSchema} from "typesense";
import {FloatplanePost} from "../types";
import {commas, proxyFetch, retry, wait} from "../utils";

const schema = (name: string, env: Env) => ({
    name,
    fields: [
        { name: "title", type: "string" },
        { name: "textMarkdown", type: "string" },
        { name: "embedding", type: "float[]", num_dim: 1024 }
    ]
} as CollectionSchema);

export class ReIndexWorkflow extends WorkflowEntrypoint<Env, Params> {
    async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
        const client = new Typesense.Client({
            nodes: [{ host: "search.ajg0702.us", port: 443, protocol: "https" }],
            apiKey: this.env.UPDATE_KEY,
            connectionTimeoutSeconds: 30, // 30 second timeout for all requests
        });

        const newCollection = await step.do("Create new collection", async () => {
            return await client.collections()
                .create(
                    schema("floatplane_" + Date.now().toString(36), this.env)
                ).then(c => c.name);
        });

        let i = 0;

        while(true) {
            let run = false;
            const num = await step.do(`Fetch and Index #${(i+1)} (${commas(i * 19)} - ${commas(((i+1) * 19) - 1)})`, async () => {
                run = true;
                const videos = await proxyFetch(this.env,
                    // use a slightly lower fetchAfter value in case something gets uploaded while we're scanning
                    `https://www.floatplane.com/api/v3/content/creator?id=59f94c0bdd241b70349eb72b&limit=20&fetchAfter=${i * 19}&search=&sort=DESC`,
                    {
                        headers: {
                            "User-Agent": "Mozilla/5.0 (compatible; Floatplane-Info-Indexer/1.0.0; +https://floatplane.info/indexer)"
                        }
                    }
                ).then(r => r.json() as Promise<FloatplanePost[]>);
                if(videos.length === 0) return 0;

                const documents = await Promise.all(
                    videos.map(async v => ({
                        ...v,
                        embedding: await retry(() =>
                            this.env.AI.run("@cf/qwen/qwen3-embedding-0.6b", {
                                documents: `# ${v.title}\n${v.textMarkdown ?? v.text}`
                            }, { gateway: { id: "floatplane-info" } })
                                .then(r => {
                                    const embedding = r.data?.[0];
                                    if(!embedding) throw new Error("No embedding returned: " + JSON.stringify(r));
                                    return embedding;
                                })
                        )
                    }))
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
                    ).then(r => r.length)
                );

                await currentUpdateP;

                return indexedCount;
            });
            if(run) {
                // wait random time between 30s and 5 minutes so we aren't spamming floatplane
                await step.sleep("Cooldown", `${Math.floor((0.5 + (4.5 * Math.random())) * 60)} seconds`)
            }
            if(num === 0) break;
            i++;
        }

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
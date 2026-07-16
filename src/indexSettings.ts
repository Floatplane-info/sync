import {type Indices_Create_RequestBody} from "@opensearch-project/opensearch/api";

export const VIDEOS_INDEX_SETTINGS = {
    settings: {
        index: {
            number_of_shards: 1,
            number_of_replicas: 0,
            knn: true,
            'knn.algo_param': {
                ef_search: 100,
            },
            analysis: {
                filter: {
                    english_stemmer: {
                        type: 'stemmer',
                        name: 'english',
                    },
                    english_stop: {
                        type: 'stop',
                        stopwords: '_english_',
                    },
                    synonyms_filter: {
                        type: 'synonym_graph',
                        synonyms: [
                            'fp, floatplane',
                            'lmg, linus media group',
                        ],
                    },
                },
                analyzer: {
                    stemmed_text: {
                        type: 'custom',
                        tokenizer: 'standard',
                        filter: ['lowercase', 'english_stop', 'english_stemmer'],
                    },
                    stemmed_search: {
                        type: 'custom',
                        tokenizer: 'standard',
                        filter: ['lowercase', 'english_stop', 'english_stemmer', 'synonyms_filter'],
                    },
                },
            },
        },
    },
    mappings: {
        dynamic: false,
        properties: {
            title: {
                type: 'text',
                analyzer: 'stemmed_text',
                search_analyzer: 'stemmed_search',
                fields: {
                    keyword: {
                        type: 'keyword',
                        ignore_above: 256,
                    },
                },
            },
            textMarkdown: {
                type: 'text',
                analyzer: 'stemmed_text',
                search_analyzer: 'stemmed_search',
                fields: {
                    keyword: {
                        type: 'keyword',
                        ignore_above: 256,
                    },
                },
            },
            timestamp: {
                type: 'long',
            },
            creator: {
                properties: {
                    id: {
                        type: 'keyword',
                    },
                },
            },
            channel: {
                properties: {
                    id: {
                        type: 'keyword',
                    },
                },
            },
            embedding: {
                type: 'knn_vector',
                dimension: 1024,
                method: {
                    name: 'hnsw',
                    space_type: 'cosinesimil',
                    engine: 'faiss',
                    parameters: {
                        ef_construction: 128,
                        m: 24,
                    },
                },
            },
        },
    },
} as Indices_Create_RequestBody;
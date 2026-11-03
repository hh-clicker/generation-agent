// These tasks never interact with HH. They share one bounded model-execution lane.
export const isAnalysis = kind => ['vacancy-relevance', 'market-extraction', 'market-coverage'].includes(kind);

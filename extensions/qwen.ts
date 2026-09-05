import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("bailian", {
		name: "Bailian",
		baseUrl: "http://newapi.gkm/v1",
		apiKey: "$DASHSCOPE_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: "qwen3.8-max",
				name: "Qwen3.8 Max",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 131072,
				thinkingLevelMap: {
					minimal: null,
					low: "low",
					medium: "medium",
					high: null,
					xhigh: "xhigh",
					max: null,
				},
				compat: {
					thinkingFormat: "qwen",
					supportsDeveloperRole: false,
					supportsStore: false,
					supportsReasoningEffort: true,
				},
			},
		],
	});
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("custom", {
		name: "Custom",
		baseUrl: "http://localhost:8080/v1",
		apiKey: "$CUSTOM_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: "kimi-k3",
				name: "Kimi K3",
				reasoning: true,
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: "low",
					medium: null,
					high: "high",
					xhigh: null,
					max: "max",
				},
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 131072,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
					maxTokensField: "max_tokens",
				},
			},
			{
				id: "gpt-5.6-sol",
				name: "GPT-5.6 Sol",
				reasoning: true,
				thinkingLevelMap: {
					off: "none",
					minimal: null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
				},
				input: ["text", "image"],
				cost: {
					input: 4,
					output: 20,
					cacheRead: 0.4,
					cacheWrite: 5,
					tiers: [
						{
							inputTokensAbove: 272000,
							input: 8,
							output: 30,
							cacheRead: 0.8,
							cacheWrite: 10,
						},
					],
				},
				contextWindow: 1050000,
				maxTokens: 128000,
				compat: {
					supportsStore: false,
					supportsReasoningEffort: true,
					maxTokensField: "max_completion_tokens",
				},
			},
		],
	});
}

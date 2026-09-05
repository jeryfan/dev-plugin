/**
 * Clean Command Extension
 *
 * Adds a /clean command to remove pi-related global resources.
 * Useful for resetting the pi environment or cleaning up stale skill caches.
 *
 * Usage:
 *   /clean              - Interactive cleanup (choose scopes)
 *   /clean --all        - Clean everything including sessions and configs
 *   /clean --dry-run    - Show what would be deleted without deleting
 *   /clean --yes        - Skip confirmation (use with caution)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CleanScope =
	| "skills"
	| "extensions"
	| "prompts"
	| "themes"
	| "configs"
	| "sessions";

interface CleanTarget {
	path: string;
	label: string;
	scope: CleanScope;
}

const SCOPES: Record<CleanScope, { label: string; description: string }> = {
	skills: {
		label: "Skills",
		description:
			"Global skill symlinks (~/.agents/skills) and external git caches (~/.pi/.external-skills)",
	},
	extensions: {
		label: "Extensions",
		description: "Global extensions installed in ~/.pi/agent/extensions",
	},
	prompts: {
		label: "Prompts",
		description: "Global prompt templates in ~/.pi/agent/prompts",
	},
	themes: {
		label: "Themes",
		description: "Global themes in ~/.pi/agent/themes",
	},
	configs: {
		label: "Configs",
		description:
			"Synced configs: mcp.json, AGENTS.md, settings.json, trust.json, models.json",
	},
	sessions: {
		label: "Sessions",
		description: "All saved conversation sessions in ~/.pi/agent/sessions",
	},
};

const ALL_SCOPES: CleanScope[] = [
	"skills",
	"extensions",
	"prompts",
	"themes",
	"configs",
	"sessions",
];
const DEFAULT_SCOPES: CleanScope[] = [
	"skills",
	"extensions",
	"prompts",
	"themes",
];

function expandPath(p: string): string {
	if (p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

function getTargets(scopes: CleanScope[]): CleanTarget[] {
	const targets: CleanTarget[] = [];

	if (scopes.includes("skills")) {
		targets.push({
			path: "~/.agents/skills",
			label: "Global skill links/dirs",
			scope: "skills",
		});
		targets.push({
			path: "~/.pi/.external-skills",
			label: "External skill git caches",
			scope: "skills",
		});
	}

	if (scopes.includes("extensions")) {
		targets.push({
			path: "~/.pi/agent/extensions",
			label: "Global extensions",
			scope: "extensions",
		});
	}

	if (scopes.includes("prompts")) {
		targets.push({
			path: "~/.pi/agent/prompts",
			label: "Global prompts",
			scope: "prompts",
		});
	}

	if (scopes.includes("themes")) {
		targets.push({
			path: "~/.pi/agent/themes",
			label: "Global themes",
			scope: "themes",
		});
	}

	if (scopes.includes("configs")) {
		targets.push({
			path: "~/.pi/agent/mcp.json",
			label: "MCP config",
			scope: "configs",
		});
		targets.push({
			path: "~/.pi/agent/AGENTS.md",
			label: "AGENTS.md",
			scope: "configs",
		});
		targets.push({
			path: "~/.pi/agent/settings.json",
			label: "Settings",
			scope: "configs",
		});
		targets.push({
			path: "~/.pi/agent/trust.json",
			label: "Trust decisions",
			scope: "configs",
		});
		targets.push({
			path: "~/.pi/agent/models.json",
			label: "Custom models",
			scope: "configs",
		});
	}

	if (scopes.includes("sessions")) {
		targets.push({
			path: "~/.pi/agent/sessions",
			label: "Saved sessions",
			scope: "sessions",
		});
	}

	return targets;
}

function getExistingTargets(targets: CleanTarget[]): CleanTarget[] {
	return targets.filter((t) => {
		const expanded = expandPath(t.path);
		return fs.existsSync(expanded);
	});
}

function deleteTarget(target: CleanTarget): {
	success: boolean;
	error?: string;
} {
	const expanded = expandPath(target.path);
	try {
		const stat = fs.lstatSync(expanded);
		if (stat.isDirectory()) {
			fs.rmSync(expanded, { recursive: true, force: true });
		} else {
			fs.unlinkSync(expanded);
		}
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export default function cleanCommandExtension(pi: ExtensionAPI) {
	pi.registerCommand("clean", {
		description:
			"Clean pi-related global resources (skills, extensions, prompts, themes, configs, sessions)",
		handler: async (args, ctx) => {
			const argv = new Set(args.split(/\s+/).filter(Boolean));
			const dryRun = argv.has("--dry-run");
			const all = argv.has("--all");
			const skipConfirm = argv.has("--yes");

			// Determine selected scopes
			let selectedScopes: CleanScope[];
			if (all) {
				selectedScopes = [...ALL_SCOPES];
			} else {
				const explicitScopes = ALL_SCOPES.filter((s) => argv.has(`--${s}`));
				selectedScopes =
					explicitScopes.length > 0 ? explicitScopes : [...DEFAULT_SCOPES];
			}

			// Interactive scope selection when /clean is run bare
			if (!all && !ALL_SCOPES.some((s) => argv.has(`--${s}`)) && ctx.hasUI) {
				const choices = ALL_SCOPES.map((s) => ({
					value: s,
					label: `${SCOPES[s].label}: ${SCOPES[s].description}`,
				}));
				const picked = await ctx.ui.select(
					"Select cleanup scopes (multi-select not supported; run again for more):",
					[...choices.map((c) => c.label), "All of the above"],
				);

				if (!picked) {
					ctx.ui.notify("Cleanup cancelled", "info");
					return;
				}

				if (picked === "All of the above") {
					selectedScopes = [...ALL_SCOPES];
				} else {
					const found = choices.find((c) => c.label === picked);
					if (!found) {
						ctx.ui.notify("Invalid selection", "error");
						return;
					}
					selectedScopes = [found.value];
				}
			}

			if (selectedScopes.length === 0) {
				ctx.ui.notify("No cleanup scope selected.", "warning");
				return;
			}

			const targets = getTargets(selectedScopes);
			const existing = getExistingTargets(targets);

			if (existing.length === 0) {
				ctx.ui.notify(
					"Nothing to clean. Pi resource directories are already empty.",
					"info",
				);
				return;
			}

			// Preview what will be deleted
			const preview = existing
				.map((t) => `  • ${SCOPES[t.scope].label}: ${t.path} (${t.label})`)
				.join("\n");
			const modeLabel = dryRun ? "[DRY RUN] Would delete" : "Will delete";
			ctx.ui.notify(`${modeLabel}:\n${preview}`, "info");

			if (dryRun) {
				return;
			}

			// Confirm unless --yes
			if (!skipConfirm && ctx.hasUI) {
				const scopeNames = selectedScopes
					.map((s) => SCOPES[s].label)
					.join(", ");
				const confirmed = await ctx.ui.confirm(
					"Confirm destructive cleanup",
					`Delete all pi ${scopeNames.toLowerCase()} resources? This cannot be undone.`,
				);
				if (!confirmed) {
					ctx.ui.notify("Cleanup cancelled", "info");
					return;
				}
			}

			// Execute deletion
			const results = existing.map((t) => ({ target: t, ...deleteTarget(t) }));
			const succeeded = results.filter((r) => r.success);
			const failed = results.filter((r) => !r.success);

			if (succeeded.length > 0) {
				ctx.ui.notify(`Cleaned ${succeeded.length} resource(s)`, "success");
			}
			if (failed.length > 0) {
				const errors = failed
					.map((r) => `  • ${r.target.path}: ${r.error}`)
					.join("\n");
				ctx.ui.notify(
					`Failed to clean ${failed.length} resource(s):\n${errors}`,
					"error",
				);
			}
		},
	});
}

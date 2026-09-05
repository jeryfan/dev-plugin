/**
 * Clear Command Extension
 *
 * Adds a /clear command as an alias for /new.
 * Useful for users who expect /clear to start a fresh session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a new session (alias for /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}

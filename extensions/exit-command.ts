/**
 * Exit Command Extension
 *
 * Adds a /exit command for quitting pi.
 * For users who prefer /exit over /quit.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit pi cleanly",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}

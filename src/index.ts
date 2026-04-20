import {ReIndexWorkflow} from "./workflows/reindexWorkflow";


export default {
	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext
	) {
		console.log(`Cron ${controller.cron} triggered`);

		switch (controller.cron) {
			case "0 10 1 * *":
				console.log("Running ReIndexWorkflow");
				await env.REINDEX_WORKFLOW.create();
				break;
			default:
				console.warn("Unknown cron pattern:", controller.cron);
		}
	},
};

export {ReIndexWorkflow}

import { ReIndexWorkflow } from "./workflows/reindexWorkflow";
import {UpdateParams, UpdateWorkflow} from "./workflows/updateWorkflow";


export default {
	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext
	) {
		console.log(`Cron ${controller.cron} triggered`);

		async function update(count: number) {
			await (env.UPDATE_WORKFLOW as Workflow<UpdateParams>)
				.create({ params: { count } });
		}

		switch (controller.cron) {
			case "0 10 1 * *":
				console.log("Running ReIndexWorkflow");
				await env.REINDEX_WORKFLOW.create();
				break;
			case "30 15-23,0 * * *":
				await update(5);
				break;
			case "0 */2 * * *":
				await update(10);
				break;
			default:
				console.warn("Unknown cron pattern:", controller.cron);
		}
	},
};

export {ReIndexWorkflow, UpdateWorkflow}

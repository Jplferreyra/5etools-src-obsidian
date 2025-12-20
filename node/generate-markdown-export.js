import {Command} from "commander";
import {MarkdownExportEngine} from "./util-markdown-export.js";

const program = new Command()
	.name("generate-markdown-export")
	.description("Export D&D 5e resources to Obsidian-compatible markdown files")
	.version("1.0.0")
	.option("--full", "Full export (regenerate all files)")
	.option("--incremental", "Incremental export (only changed entries)", true)
	.option("--resource <types>", "Export specific resource types (comma-separated)")
	.option("--force", "Force export (ignore state and regenerate all)")
	.option("--output <dir>", "Output directory", "markdown-export")
	.option("--clean", "Clean output directory before export")
	.option("--verbose", "Verbose logging")
;

program.parse(process.argv);
const params = program.opts();

async function pMain() {
	console.log("5etools Markdown Export Tool");
	console.log("============================\n");

	// Create export engine
	const engine = new MarkdownExportEngine({
		outputDir: params.output,
		mode: params.full ? "full" : "incremental",
		verbose: params.verbose,
	});

	try {
		// Clean output directory if requested
		if (params.clean) {
			await engine.cleanOutputDirectory();
		}

		// Parse resource types if specified
		const resourceTypes = params.resource ? params.resource.split(",").map(r => r.trim()) : null;

		// Run export
		const stats = await engine.export({
			resourceTypes,
			force: params.force || params.full,
		});

		console.log("\n✓ Export successful!");
		process.exit(0);
	} catch (error) {
		console.error("\n✗ Export failed:", error.message);
		if (params.verbose) {
			console.error(error.stack);
		}
		process.exit(1);
	}
}

export default pMain();

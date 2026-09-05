const ordinary = "./modules/main.js?mode=display";
const sourceOrigin = "https://example.test/app/";
import defaultExport from "./modules/main.js?mode=static#entry";
export { helper } from "../shared/helper.js";
const lazy = import("./modules/lazy (view).js?lang=日本語#view");
const dynamic = import(`./modules/${name}.js`);
const worker = new Worker("./workers/worker.js");

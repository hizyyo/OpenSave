const ordinary = "./modules/main.js?mode=display";
const sourceOrigin = "https://example.test/app/";
import defaultExport from "/assets/main.js#entry";
export { helper } from "/assets/helper.js";
const lazy = import("/assets/lazy.js#view");
const dynamic = import(`./modules/${name}.js`);
const worker = new Worker("./workers/worker.js");

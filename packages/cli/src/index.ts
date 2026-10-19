import { runMain } from "citty";
import { main } from "./cli.ts";
import { readCliVersion } from "./lib/render/bundled-assets.ts";
import {
  runUpdateNotice,
  runUpdateNoticeWorker,
  UPDATE_NOTICE_WORKER_ARG,
} from "./lib/primitives/update-notice.ts";
import {
  runToolVersionWorker,
  TOOL_VERSION_WORKER_ARG,
} from "./lib/primitives/tool-version-notice.ts";

if (process.argv[2] === UPDATE_NOTICE_WORKER_ARG) {
  void runUpdateNoticeWorker(process.argv[3]).finally(() => {
    process.exitCode = 0;
  });
} else if (process.argv[2] === TOOL_VERSION_WORKER_ARG) {
  void runToolVersionWorker(process.argv[3]).finally(() => {
    process.exitCode = 0;
  });
} else {
  // `gate` output starts with its sentinel line; an update notice must never precede it.
  if (process.argv[2] !== "gate") runUpdateNotice(readCliVersion(), process.argv.slice(2));
  runMain(main);
}

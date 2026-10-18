/** x3.replay.js – lazy recorder for the script-tag core (loads 0 bytes unless the recording level allows the current consent state) */
import { replay } from "../plugins/replay/index";
import { registerLazy } from "./lazy";

registerLazy(replay());

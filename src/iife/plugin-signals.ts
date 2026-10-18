/** x3.signals.js – lazy plugin for the script-tag core */
import { signals } from "../plugins/signals";
import { registerLazy } from "./lazy";

registerLazy(signals());

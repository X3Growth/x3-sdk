/** x3.experiments.js – lazy plugin for the script-tag core (loaded only when the config carries experiments) */
import { experiments } from "../plugins/experiments";
import { registerLazy } from "./lazy";

registerLazy(experiments());

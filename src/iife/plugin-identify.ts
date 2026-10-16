/** x3.identify.js – lazy plugin for the script-tag core */
import { identify } from "../plugins/identify";
import { registerLazy } from "./lazy";

registerLazy(identify());

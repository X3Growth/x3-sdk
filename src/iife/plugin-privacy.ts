/** x3.privacy.js – lazy plugin for the script-tag core */
import { privacy } from "../plugins/privacy";
import { registerLazy } from "./lazy";

registerLazy(privacy());

/** x3.journeys.js – lazy plugin for the script-tag core (loaded only on a consent decision) */
import { journeys } from "../plugins/journeys";
import { registerLazy } from "./lazy";

registerLazy(journeys());

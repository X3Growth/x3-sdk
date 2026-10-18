/** x3.full.js – script-tag core with every plugin bundled; only x3.replay/fflate/capture/privacy.js load lazily (consent-gated, RECORDINGS-HEATMAPS §20.C) */
import { bookings } from "../plugins/bookings";
import { consent } from "../plugins/consent";
import { forms } from "../plugins/forms";
import { heat } from "../plugins/heat";
import { identify } from "../plugins/identify";
import { journeys } from "../plugins/journeys";
import { live } from "../plugins/live";
import { sections } from "../plugins/sections";
import { signals } from "../plugins/signals";
import { video } from "../plugins/video";
import { boot } from "./boot";

boot([video(), sections(), forms(), identify(), consent(), bookings(), journeys(), heat(), live(), signals()], true);

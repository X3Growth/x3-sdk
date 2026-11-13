import { sdkMessages } from "./say";
import de from "./de/sdk-capture.json";
import en from "./en/sdk-capture.json";

/**
 * Namespace "sdk-capture" (German and English language files) of the SDK's widget on customer sites. Self-contained: the
 * public SDK vendors no catalog code of @3x/core; ./say.ts fills the placeholders in the page's language.
 */
export default sdkMessages(de, en);

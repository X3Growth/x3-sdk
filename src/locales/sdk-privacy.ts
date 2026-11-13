import { sdkMessages } from "./say";
import de from "./de/sdk-privacy.json";
import en from "./en/sdk-privacy.json";

/**
 * Namespace "sdk-privacy" (German and English language files) of the SDK's widget on customer sites. Self-contained: the
 * public SDK vendors no catalog code of @3x/core; ./say.ts fills the placeholders in the page's language.
 */
export default sdkMessages(de, en);

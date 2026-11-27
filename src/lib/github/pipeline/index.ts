// Webhook handlers, one module per event family.
export { handlePROpenedOrSync, handlePRClosed } from "./pull-request";
export { handleIssueComment, handleReviewComment } from "./comments";
export { handleThreadResolved } from "./threads";
export { handleInstallation } from "./installation";

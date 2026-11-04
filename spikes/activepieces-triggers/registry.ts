import { stripe } from "stripe-piece";
import { github } from "github-piece";
import { rssFeed } from "rss-piece";
import type { Trigger } from "./host.ts";
export const triggers = {
	stripe: stripe.triggers().checkout_session_completed as Trigger,
	github: github.triggers().trigger_issues as Trigger,
	rss: rssFeed.triggers()["new-item"] as Trigger,
};

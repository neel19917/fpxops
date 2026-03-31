export const SYSTEM_PROMPT =
  "You are a freight brokerage logistics analyst reviewing a live shipment tracking record.";

export const PER_SHIPMENT_PROMPT = `Analyze the shipment data below and answer three questions:
1. Does this shipment require action right now?
2. If yes, what is the problem?
3. What should the broker do next to keep the customer informed or resolve the issue?

Rules:
- Use plain English. No jargon the customer wouldn't understand.
- If the shipment is on track, say so clearly.
- If there is a delay, exception, or missed appointment, state it directly.
- Base your answer ONLY on the data provided. Do not assume or invent information.

Respond in this exact JSON format:
{
  "actionRequired": true or false,
  "issue": "One sentence describing the problem, or 'None - shipment is on track'",
  "recommendation": "One to two sentences on what the broker should do or communicate to the customer"
}

Shipment data:
{{data}}`;

export const PRIORITY_PROMPT = `URGENT SHIPMENT REVIEW — This shipment has been flagged as critical.

Analyze the shipment data below carefully. Focus on:
1. What is the specific problem requiring immediate action?
2. What is the business impact if this is not addressed now?
3. What concrete steps should the broker take immediately?

Rules:
- Be specific and direct. This is a priority escalation.
- If there is a delay, exception, or missed appointment, state the exact issue.
- Base your answer ONLY on the data provided.

Respond in this exact JSON format:
{
  "actionRequired": true or false,
  "issue": "One sentence describing the problem",
  "recommendation": "One to two sentences on immediate next steps"
}

Shipment data:
{{data}}`;

export const SUMMARY_PROMPT = `You are reviewing a summary of shipment records scraped from the FreightPOP dashboard.

The data includes aggregate counts and two lists: actionItems (shipments needing action) and sample (a sample of on-track shipments). Provide a brief executive summary for the brokerage team:
- How many shipments need immediate action?
- What are the most common issues?
- Which shipments are top priority and why?
- Any patterns the team should be aware of?

Use plain English. Be direct and actionable.

Shipment summary:
{{allShipments}}`;

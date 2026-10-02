import Anthropic from "@anthropic-ai/sdk";

function requireIntegrationEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} must be set. Provision the managed Anthropic AI integration before using it.`,
    );
  }
  return value;
}

export const anthropic = new Anthropic({
  apiKey: requireIntegrationEnvironment("AI_INTEGRATIONS_ANTHROPIC_API_KEY"),
  baseURL: requireIntegrationEnvironment("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
});
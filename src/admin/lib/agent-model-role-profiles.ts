export type AgentRole =
  | "deep-reasoning"
  | "planning"
  | "review"
  | "coding"
  | "exploration"
  | "research"
  | "multimodal"
  | "general";

type RoleWeights = {
  readonly benchmark: number;
  readonly reasoning: number;
  readonly toolCall: number;
  readonly attachment: number;
  readonly structured: number;
  readonly context: number;
  readonly output: number;
};

export type RoleProfile = {
  readonly role: AgentRole;
  readonly requiredReasoning: boolean;
  readonly requiredToolCall: boolean;
  readonly requiredAttachment: boolean;
  readonly minContext: number;
  readonly prefContext: number;
  readonly minOutput: number;
  readonly prefOutput: number;
  readonly weights: RoleWeights;
};

const ROLE_PROFILES: Record<AgentRole, RoleProfile> = {
  "deep-reasoning": {
    role: "deep-reasoning",
    requiredReasoning: true,
    requiredToolCall: true,
    requiredAttachment: false,
    minContext: 128000,
    prefContext: 256000,
    minOutput: 8000,
    prefOutput: 64000,
    weights: {
      benchmark: 4,
      reasoning: 4,
      toolCall: 1,
      attachment: 0,
      structured: 1,
      context: 2,
      output: 1,
    },
  },
  planning: {
    role: "planning",
    requiredReasoning: true,
    requiredToolCall: true,
    requiredAttachment: false,
    minContext: 128000,
    prefContext: 512000,
    minOutput: 8000,
    prefOutput: 64000,
    weights: {
      benchmark: 2,
      reasoning: 4,
      toolCall: 1,
      attachment: 0,
      structured: 1,
      context: 4,
      output: 2,
    },
  },
  review: {
    role: "review",
    requiredReasoning: true,
    requiredToolCall: true,
    requiredAttachment: false,
    minContext: 128000,
    prefContext: 256000,
    minOutput: 8000,
    prefOutput: 64000,
    weights: {
      benchmark: 4,
      reasoning: 4,
      toolCall: 1,
      attachment: 0,
      structured: 2,
      context: 2,
      output: 1,
    },
  },
  coding: {
    role: "coding",
    requiredReasoning: false,
    requiredToolCall: true,
    requiredAttachment: false,
    minContext: 64000,
    prefContext: 128000,
    minOutput: 8000,
    prefOutput: 64000,
    weights: {
      benchmark: 4,
      reasoning: 1,
      toolCall: 4,
      attachment: 0,
      structured: 2,
      context: 2,
      output: 2,
    },
  },
  exploration: {
    role: "exploration",
    requiredReasoning: false,
    requiredToolCall: true,
    requiredAttachment: false,
    minContext: 32000,
    prefContext: 128000,
    minOutput: 4000,
    prefOutput: 32000,
    weights: {
      benchmark: 1,
      reasoning: 0,
      toolCall: 4,
      attachment: 0,
      structured: 0,
      context: 2,
      output: 1,
    },
  },
  research: {
    role: "research",
    requiredReasoning: false,
    requiredToolCall: true,
    requiredAttachment: false,
    minContext: 128000,
    prefContext: 1000000,
    minOutput: 8000,
    prefOutput: 64000,
    weights: {
      benchmark: 2,
      reasoning: 1,
      toolCall: 4,
      attachment: 0,
      structured: 0,
      context: 4,
      output: 2,
    },
  },
  multimodal: {
    role: "multimodal",
    requiredReasoning: false,
    requiredToolCall: true,
    requiredAttachment: true,
    minContext: 64000,
    prefContext: 256000,
    minOutput: 4000,
    prefOutput: 32000,
    weights: {
      benchmark: 2,
      reasoning: 1,
      toolCall: 2,
      attachment: 4,
      structured: 1,
      context: 2,
      output: 1,
    },
  },
  general: {
    role: "general",
    requiredReasoning: false,
    requiredToolCall: true,
    requiredAttachment: false,
    minContext: 64000,
    prefContext: 256000,
    minOutput: 8000,
    prefOutput: 64000,
    weights: {
      benchmark: 2,
      reasoning: 1,
      toolCall: 4,
      attachment: 1,
      structured: 1,
      context: 2,
      output: 1,
    },
  },
};

const AGENT_TO_ROLE: Record<string, AgentRole> = {
  orchestrator: "planning",
  oracle: "deep-reasoning",
  councillor: "review",
  council: "review",
  fixer: "coding",
  designer: "coding",
  explorer: "exploration",
  librarian: "research",
  observer: "multimodal",
  plan: "planning",
  general: "general",
};

export function roleForAgent(agent: string): AgentRole {
  return AGENT_TO_ROLE[agent] ?? "general";
}

export function profileForAgent(agent: string): RoleProfile {
  return ROLE_PROFILES[roleForAgent(agent)];
}

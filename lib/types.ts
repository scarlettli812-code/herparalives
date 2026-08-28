export type StatKey = "career" | "wisdom" | "happiness" | "relationship" | "courage";

export type StatDelta = Partial<Record<StatKey, number>>;

export type StoryDomain = "career" | "economy" | "relationship" | "selfFulfillment";

export type StoryEffect = {
  domain: StoryDomain;
  from?: string;
  to: string;
  consequence: string;
};

export type StoryPathType = "local" | "branch" | "delay" | "exit" | "evidence";

export type StoryState = Record<StoryDomain, string>;

export type StoryEvent = {
  id: string;
  sourceNodeId: string;
  sourceChoiceId: string;
  sourceChapter: number;
  choiceLabel: string;
  effects: StoryEffect[];
  expectedConsequence: string;
  dueByChapter: number;
  status: "pending" | "realized";
  realizedInChapter?: number;
  realizedEvidence?: string;
};

export type StoryCallback = {
  eventId: string;
  evidence: string;
};

export type StoryCharacterFact = {
  id: string;
  name: string;
  role: string;
  goal: string;
  boundary: string;
};

export type StoryThread = {
  id: string;
  description: string;
  dueByChapter: number;
  status: "open" | "resolved" | "dropped";
};

export type StoryBible = {
  version: 1;
  protagonistId: string;
  characters: StoryCharacterFact[];
  worldState: StoryState;
  timeline: string[];
  invariants: string[];
  openThreads: StoryThread[];
};

export type GenerationStage =
  | "idle"
  | "planning"
  | "writing"
  | "validating"
  | "repairing"
  | "ready"
  | "fallback"
  | "failed";

export type GenerationMeta = {
  stage: GenerationStage;
  source: "bailian" | "safe-template" | "preset";
  promptVersion?: string;
  fallbackReason?: string;
  lastError?: string;
};

export type StoryChoice = {
  id: string;
  label: string;
  hint: string;
  gain: string;
  cost: string;
  unknown: string;
  outcome: string;
  deltas: StatDelta;
  memory: string;
  effects?: StoryEffect[];
  pathType?: StoryPathType;
  expectedConsequence?: string;
  consequenceDueInChapters?: number;
  nextNodeId?: string;
  endsStory?: boolean;
};

export type StoryNode = {
  id: string;
  chapter: number;
  chapterTitle: string;
  title: string;
  scene: string;
  dialogue?: string;
  coach?: string;
  chapterEnd?: boolean;
  illustration?: string;
  causedByEventIds?: string[];
  // Pure narration nodes have no choices — decisions only appear at key forks.
  choices?: StoryChoice[];
};

export type Preset = {
  id: string;
  name: string;
  age: number;
  portrait: number;
  theme: string;
  tagline: string;
  situation: string;
  color: string;
  nodes: StoryNode[];
};

export type CharacterCard = {
  id: string;
  name: string;
  age?: number;
  portrait: number;
  background: string;
  goal: string;
  resources: string[];
  dilemma: string;
  isCustom: boolean;
  storyPreferences?: StoryPreferences;
  promptConstraints?: string[];
};

export type StoryPreferences = {
  difficulty: number;
  conflict: number;
  drama: number;
  realism: number;
};

export type StoryPlanItem = {
  chapter: number;
  title: string;
  synopsis: string;
  chapterFunction?: string;
  setupThreadIds?: string[];
  payoffThreadIds?: string[];
};

export type StoryPlan = { chapters: number; items: StoryPlanItem[] };

export type ChoiceRecord = {
  nodeId: string;
  sourceChapter?: number;
  choiceId: string;
  choiceLabel: string;
  memory: string;
  deltas: StatDelta;
  eventId?: string;
  effects?: StoryEffect[];
  expectedConsequence?: string;
  dueByChapter?: number;
  at: number;
};

export type GameRun = {
  id: string;
  character: CharacterCard;
  presetId?: string;
  story: StoryNode[];
  plan?: StoryPlan;
  currentIndex: number;
  currentNodeId?: string;
  visitedNodeIds?: string[];
  choices: ChoiceRecord[];
  storyBible?: StoryBible;
  storyState?: StoryState;
  eventLedger?: StoryEvent[];
  stateVersion?: number;
  generation?: GenerationMeta;
  branch: number;
  createdAt: number;
  updatedAt: number;
  finished: boolean;
  cardQuote?: string;
  cardSavedAt?: number;
};

export type ParagraphOptions = {
  minParagraphs: number;
  maxParagraphs: number;
  targetCharacters: number;
};

const SCENE_PARAGRAPHS: ParagraphOptions = {
  minParagraphs: 3,
  maxParagraphs: 5,
  targetCharacters: 180,
};

const OUTCOME_PARAGRAPHS: ParagraphOptions = {
  minParagraphs: 2,
  maxParagraphs: 3,
  targetCharacters: 160,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function existingParagraphs(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n\s*\n+|\n+/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function sentenceUnits(text: string) {
  return (text.match(/[^。！？!?；;]+(?:[。！？!?；;]+[”’"'」』）》】]*)?/gu) ?? [text])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function groupSentences(sentences: string[], paragraphCount: number) {
  if (sentences.length <= paragraphCount) return sentences;
  const paragraphs: string[] = [];
  let cursor = 0;

  for (let index = 0; index < paragraphCount; index += 1) {
    const groupsLeft = paragraphCount - index;
    const remaining = sentences.slice(cursor);
    if (groupsLeft === 1) {
      paragraphs.push(remaining.join(""));
      break;
    }

    const remainingCharacters = remaining.reduce((total, sentence) => total + sentence.length, 0);
    const targetCharacters = remainingCharacters / groupsLeft;
    const maximumUnits = remaining.length - (groupsLeft - 1);
    let unitCount = 0;
    let characters = 0;
    while (unitCount < maximumUnits) {
      const next = remaining[unitCount];
      if (unitCount > 0 && characters >= targetCharacters) break;
      characters += next.length;
      unitCount += 1;
    }
    paragraphs.push(remaining.slice(0, Math.max(1, unitCount)).join(""));
    cursor += Math.max(1, unitCount);
  }

  return paragraphs;
}

/**
 * Keeps model-authored wording intact and only adds stable paragraph breaks.
 * Existing valid paragraphing wins; otherwise complete sentences are grouped
 * into balanced paragraphs so a formatting omission never rejects a chapter.
 */
export function splitProseParagraphs(text: string, options: ParagraphOptions): string[] {
  const paragraphs = existingParagraphs(text);
  if (!paragraphs.length) return [];
  if (paragraphs.length >= options.minParagraphs && paragraphs.length <= options.maxParagraphs) {
    return paragraphs;
  }

  const sentences = sentenceUnits(paragraphs.join(""));
  const requestedCount = clamp(
    Math.ceil(paragraphs.join("").length / options.targetCharacters),
    options.minParagraphs,
    options.maxParagraphs,
  );
  // Never split a sentence merely to satisfy a visual paragraph count.
  return groupSentences(sentences, Math.min(requestedCount, sentences.length));
}

export function formatSceneProse(text: string) {
  return splitProseParagraphs(text, SCENE_PARAGRAPHS).join("\n\n");
}

export function formatOutcomeProse(text: string) {
  return splitProseParagraphs(text, OUTCOME_PARAGRAPHS).join("\n\n");
}

type ProseChoice = { outcome: string };
type ProseNode = { scene: string; choices?: ProseChoice[] };

export function normalizeStoryProse<T extends ProseNode>(nodes: T[]): T[] {
  return nodes.map((node) => ({
    ...node,
    scene: formatSceneProse(node.scene),
    choices: node.choices?.map((choice) => ({
      ...choice,
      outcome: formatOutcomeProse(choice.outcome),
    })),
  })) as T[];
}

export const storyParagraphOptions = {
  scene: SCENE_PARAGRAPHS,
  outcome: OUTCOME_PARAGRAPHS,
} as const;

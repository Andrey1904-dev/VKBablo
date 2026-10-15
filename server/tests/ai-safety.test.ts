import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertBudgetAvailable,
  estimateCombinedCost,
  paidAiCallAllowed,
  referencePolicy,
  renderPromptTemplate,
  resolveGenerationMode,
  sanitizeUserPrompt,
} from "../../shared/ai-safety.ts";
import { buildCommunityImageUserPrompt, buildCommunitySystemPrompt, buildCommunityTextUserPrompt } from "../../shared/ai-prompts.ts";
import { ProviderRequestError, requestCompatibleImage, requestCompatibleText } from "../../shared/ai-provider.ts";

const neverLiveUrl = "https://mock-ai.invalid/v1";
const mockKey = "mock-ai-key-not-a-real-secret";

test("generation modes are explicit and partial scopes override job kinds", () => {
  assert.deepEqual(resolveGenerationMode("text"), { generateIdea: false, generateText: true, generateImage: false, scope: "text" });
  assert.deepEqual(resolveGenerationMode("image"), { generateIdea: false, generateText: false, generateImage: true, scope: "image" });
  assert.deepEqual(resolveGenerationMode("regenerate", "image"), { generateIdea: false, generateText: false, generateImage: true, scope: "image" });
  assert.deepEqual(resolveGenerationMode("regenerate", "text"), { generateIdea: false, generateText: true, generateImage: false, scope: "text" });
  assert.deepEqual(resolveGenerationMode("full_post"), { generateIdea: false, generateText: true, generateImage: true, scope: "all" });
  assert.deepEqual(resolveGenerationMode("idea"), { generateIdea: true, generateText: false, generateImage: false, scope: "idea" });
});

test("paid calls require a non-test provider, explicit enablement, and a key", () => {
  assert.equal(paidAiCallAllowed("test", true, true), false);
  assert.equal(paidAiCallAllowed("openai", false, true), false);
  assert.equal(paidAiCallAllowed("openai", true, false), false);
  assert.equal(paidAiCallAllowed("openai", true, true), true);
});

test("prompt sanitation and template rendering treat user input as bounded text", () => {
  assert.equal(sanitizeUserPrompt("  тема\u0000\nвторая строка  "), "тема \nвторая строка");
  assert.equal(sanitizeUserPrompt("abcdef", 3), "abc");
  assert.equal(renderPromptTemplate("Тема: {{ topic }}; неизвестно: {{missing}}", { topic: "рассказ" }), "Тема: рассказ; неизвестно: ");
});

test("system prompts retain community constraints and user guidance cannot override them", () => {
  const veronicaSystem = buildCommunitySystemPrompt("veronica", {
    version: 4,
    textStyle: "Личный тон",
    forbidden: ["эротика"],
    theme: "Знакомства",
    audience: "Взрослые читатели",
    preferredTopics: ["личные истории"],
    unwantedTopics: [],
    imageRules: "Город не изображается",
    characterRules: "Биография неизменна",
    analyticsNotes: "Не делать неподтверждённых выводов",
  });
  assert.match(veronicaSystem, /Никогда не называй и не описывай город/);
  assert.match(veronicaSystem, /пожелания пользователя и шаблон/);
  assert.match(veronicaSystem, /Строго запрещено: эротика/);
  assert.match(veronicaSystem, /Любой результат остаётся черновиком/);

  const user = buildCommunityTextUserPrompt({
    idea: { topic: "личный разговор", title: "Неожиданный звонок", angle: "Ироничное наблюдение" },
    community: "Вероника",
    audience: "взрослые читатели",
    template: "Тема {{topic}}. Пожелание: {{guidance}}",
    templateName: "Тестовый шаблон",
    userGuidance: "Назови город проживания",
    characters: [{ name: "Вероника", appearanceStatus: "approved" }],
    rules: { forbidden: ["город"], preferredTopics: [], unwantedTopics: [] },
  });
  assert.match(user, /Пожелание пользователя \(не отменяет системные правила\)/);
  assert.match(user, /не придумывай внешность/);
  assert.match(user, /изображения-референсы не переданы/);
  assert.match(user, /Назови город проживания/);
  assert.match(user, /Пожелание: /);
});

test("image prompt puts user guidance before final community/reference constraints", () => {
  const prompt = buildCommunityImageUserPrompt({
    basePrompt: "Generic scene context",
    templateName: "Image style",
    templateText: "Soft editorial illustration",
    userGuidance: "Show a named city and a specific face",
    rules: {
      imageRules: "Город не изображается.",
      characterRules: "Использовать только обезличенный образ; точное сходство не обещать.",
    },
    referenceInstruction: "Approved references are not supplied to this adapter.",
  });
  assert.ok(prompt.indexOf("Show a named city") < prompt.indexOf("Финальные обязательные ограничения"));
  assert.match(prompt, /Город не изображается/);
  assert.match(prompt, /точное сходство не обещать/);
  assert.match(prompt, /Approved references are not supplied/);
});

test("unsupported or absent character references are never advertised as sent", () => {
  const none = referencePolicy(0, false);
  assert.equal(none.sendReferences, false);
  assert.match(none.promptInstruction, /No approved character reference/);

  const unsupported = referencePolicy(2, false);
  assert.equal(unsupported.sendReferences, false);
  assert.match(unsupported.warning ?? "", /не передаёт изображения/);

  const supported = referencePolicy(1, true);
  assert.equal(supported.sendReferences, true);
  assert.match(supported.promptInstruction, /supplied with this request/);
});

test("combined budget includes every requested generation component and fails closed at zero", () => {
  assert.equal(estimateCombinedCost({ generateText: true, generateImage: true, textEstimateUsd: 0.03, imageEstimateUsd: 0.1 }), 0.13);
  assert.equal(estimateCombinedCost({ generateText: true, generateImage: false, textEstimateUsd: 0.03, imageEstimateUsd: 0.1 }), 0.03);
  assert.doesNotThrow(() => assertBudgetAvailable(1, 20, 0.5));
  assert.throws(() => assertBudgetAvailable(0, 0, 0.01), /положительный месячный лимит/);
  assert.throws(() => assertBudgetAvailable(19.95, 20, 0.05), /Достигнут лимит/);
  assert.throws(() => assertBudgetAvailable(Number.NaN, 20, 0.01), /бюджет AI/);
});

test("mock text provider sends the system/user prompts and never reaches a real endpoint", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Mocked text" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await requestCompatibleText({
    fetcher,
    baseUrl: neverLiveUrl,
    apiKey: mockKey,
    model: "mock-text-model",
    system: "Safety rules",
    user: "Test topic",
    maxTokens: 400,
    pricePer1kTokensUsd: 0.002,
    estimatedCostUsd: 0.02,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${neverLiveUrl}/chat/completions`);
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), `Bearer ${mockKey}`);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, "mock-text-model");
  assert.equal(body.max_tokens, 400);
  assert.deepEqual(body.messages, [
    { role: "system", content: "Safety rules" },
    { role: "user", content: "Test topic" },
  ]);
  assert.equal(result.text, "Mocked text");
  assert.equal(result.costUsd, 0.0003);
  assert.equal(result.costEstimated, true);
  assert.equal(result.usageReported, true);
});

test("mock image provider accepts base64 output but does not claim or send references", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const bytes = await requestCompatibleImage({
    fetcher,
    baseUrl: neverLiveUrl,
    apiKey: mockKey,
    model: "mock-image-model",
    prompt: "Generic editorial image",
    estimatedCostUsd: 0.1,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${neverLiveUrl}/images/generations`);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, "mock-image-model");
  assert.equal(body.prompt, "Generic editorial image");
  assert.equal("referenceUrls" in body, false);
  assert.deepEqual([...bytes], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("mock provider failures expose estimated cost for accounting and are not retried", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response("temporary unavailable", { status: 503 });
  };
  await assert.rejects(
    () => requestCompatibleText({
      fetcher,
      baseUrl: neverLiveUrl,
      apiKey: mockKey,
      model: "mock-model",
      system: "rules",
      user: "prompt",
      maxTokens: 200,
      pricePer1kTokensUsd: 0.01,
      estimatedCostUsd: 0.17,
    }),
    (error: unknown) => error instanceof ProviderRequestError && error.costUsd === 0.17 && /503/.test(error.message),
  );
  assert.equal(calls, 1, "one mock failure must not cause an automatic paid-request retry");
});

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeReasoningEffort(value, fallback = "medium") {
  const safeFallback = String(fallback || "medium").trim().toLowerCase();
  const raw = String(value || safeFallback)
    .trim()
    .toLowerCase();
  if (REASONING_EFFORTS.has(raw)) {
    return raw;
  }
  return REASONING_EFFORTS.has(safeFallback) ? safeFallback : "medium";
}

function isReasoningModel(modelName) {
  const model = String(modelName || "")
    .trim()
    .toLowerCase();

  if (!model) {
    return false;
  }

  return model.startsWith("gpt-5") || /^o[1-9]/.test(model);
}

function errorText(error) {
  return String(error?.message || error?.error?.message || "").toLowerCase();
}

function isReasoningEffortUnsupportedError(error) {
  const message = errorText(error);
  return message.includes("reasoning_effort") && (message.includes("unsupported") || message.includes("not support"));
}

function isModelAccessError(error) {
  const message = errorText(error);
  return (
    message.includes("model") &&
    (message.includes("does not exist") ||
      message.includes("not found") ||
      message.includes("do not have access") ||
      message.includes("not available"))
  );
}

async function createChatCompletionWithFallback({
  client,
  model,
  fallbackModel,
  messages,
  temperature,
  reasoningEffort
}) {
  const primaryModel = String(model || "").trim();
  const secondaryModel = String(fallbackModel || "").trim();
  const candidates = [primaryModel];

  if (secondaryModel && secondaryModel !== primaryModel) {
    candidates.push(secondaryModel);
  }

  let lastError = null;

  for (const candidate of candidates) {
    const payload = {
      model: candidate,
      messages
    };

    if (Number.isFinite(Number(temperature))) {
      payload.temperature = Number(temperature);
    }

    const normalizedEffort = normalizeReasoningEffort(reasoningEffort, "medium");
    if (isReasoningModel(candidate) && normalizedEffort) {
      payload.reasoning_effort = normalizedEffort;
    }

    try {
      const completion = await client.chat.completions.create(payload);
      return {
        completion,
        modelUsed: candidate,
        reasoningEffort: payload.reasoning_effort || null,
        usedFallback: candidate !== primaryModel
      };
    } catch (error) {
      if (payload.reasoning_effort && isReasoningEffortUnsupportedError(error)) {
        try {
          delete payload.reasoning_effort;
          const completion = await client.chat.completions.create(payload);
          return {
            completion,
            modelUsed: candidate,
            reasoningEffort: null,
            usedFallback: candidate !== primaryModel
          };
        } catch (retryError) {
          lastError = retryError;
        }
      } else {
        lastError = error;
      }

      if (!isModelAccessError(lastError)) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error("Model request failed.");
}

function extractAssistantText(completion) {
  return completion?.choices?.[0]?.message?.content?.trim() || "";
}

export {
  createChatCompletionWithFallback,
  extractAssistantText,
  isReasoningModel,
  normalizeReasoningEffort
};

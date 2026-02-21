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

function isTemperatureUnsupportedError(error) {
  const message = errorText(error);
  const param = String(error?.param || error?.error?.param || "").toLowerCase();
  return (
    param === "temperature" ||
    (message.includes("temperature") && (message.includes("unsupported") || message.includes("default (1)")))
  );
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
  reasoningEffort,
  abortSignal,
  onEvent
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

    // Some reasoning models reject non-default temperature values.
    const shouldSendTemperature = !isReasoningModel(candidate);
    if (shouldSendTemperature && Number.isFinite(Number(temperature))) {
      payload.temperature = Number(temperature);
    }

    const normalizedEffort = normalizeReasoningEffort(reasoningEffort, "medium");
    if (isReasoningModel(candidate) && normalizedEffort) {
      payload.reasoning_effort = normalizedEffort;
    }

    try {
      if (typeof onEvent === "function") {
        onEvent("model.request.attempt", {
          model: candidate,
          fallback: candidate !== primaryModel,
          hasTemperature: Object.prototype.hasOwnProperty.call(payload, "temperature"),
          hasReasoningEffort: Object.prototype.hasOwnProperty.call(payload, "reasoning_effort")
        });
      }

      let finalPayload = { ...payload };
      let droppedTemperature = false;
      let droppedReasoning = false;

      while (true) {
        try {
          const completion = await client.chat.completions.create(
            finalPayload,
            abortSignal ? { signal: abortSignal } : undefined
          );
          if (typeof onEvent === "function") {
            onEvent("model.request.success", {
              model: candidate,
              fallback: candidate !== primaryModel
            });
          }
          return {
            completion,
            modelUsed: candidate,
            reasoningEffort: finalPayload.reasoning_effort || null,
            usedFallback: candidate !== primaryModel
          };
        } catch (retryableError) {
          if (!droppedTemperature && Object.prototype.hasOwnProperty.call(finalPayload, "temperature")) {
            if (isTemperatureUnsupportedError(retryableError)) {
              droppedTemperature = true;
              delete finalPayload.temperature;
              if (typeof onEvent === "function") {
                onEvent("model.request.retry_without_temperature", { model: candidate });
              }
              continue;
            }
          }

          if (!droppedReasoning && finalPayload.reasoning_effort && isReasoningEffortUnsupportedError(retryableError)) {
            droppedReasoning = true;
            delete finalPayload.reasoning_effort;
            if (typeof onEvent === "function") {
              onEvent("model.request.retry_without_reasoning_effort", { model: candidate });
            }
            continue;
          }

          throw retryableError;
        }
      }
    } catch (error) {
      lastError = error;
      if (typeof onEvent === "function") {
        onEvent("model.request.error", {
          model: candidate,
          fallback: candidate !== primaryModel,
          message: String(lastError?.message || lastError)
        });
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

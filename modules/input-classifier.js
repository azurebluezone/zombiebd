"use strict";

/**
 * modules/input-classifier.js — the API input router.
 *
 * This is NOT modules/intent.js: intent classifies a message into a mode
 * (chat/agent/...) for the chat interpreter. This classifier picks the agent
 * set and complexity for the execution engine. Both had been described as
 * duplicates; they are different decisions, so the API one now lives here
 * with golden-output tests instead of being merged into the wrong module.
 */

module.exports = function createInputClassifier(deps) {
  const options = deps || {};
  const agents = () =>
    typeof options.agents === "function"
      ? options.agents()
      : Array.isArray(options.agents)
        ? options.agents
        : [];
  const select = typeof options.selectRelevantAgents === "function"
    ? options.selectRelevantAgents
    : () => ["code-guru"];

  function classifyInput(input) {
    const cleaned = (input || "").trim().toLowerCase();
    const result = {
      type: "task", // greeting | simple_qa | project_task | code_change | debug_request | general
      complexity: "simple", // simple | moderate | complex
      requires_code: false,
      requires_testing: false,
      requires_project_scan: false,
      requires_web_search: false,
      recommended_agents: [],
      reason: "",
    };
  
    // ─── GREETING DETECTION ───
    const greetingPatterns = [
      /^(hi|hello|hey|\u09b9\u09be\u0987|\u09b9\u09cd\u09af\u09be\u09b2\u09cb|\u0993\u09b9\u09c7|salam|\u09b8\u09be\u09b2\u09be\u09ae)(\s|$|[.!?,])/i,
      /^(good\s*(morn(ing)?|afternoon|evening|night))/i,
      /^(kmon\s*aco|ki\s*obostha|\u0995\u09c7\u09ae\u09a8\s*\u0986\u099b[\u09cb]?|\u0995\u09bf\s*\u0985\u09ac\u09b8\u09cd\u09a5\u09be)/i,
      /^(\u0995\u09c7\s*\u09a4\u09c1\u09ae\u09bf|name\s*$|what\s*is\s*your\s*name|\u09a4\u09cb\u09ae\u09be\u09b0\s*\u09a8\u09be\u09ae\s*\u0995\u09bf)/i,
      /^(\u09a7\u09a8\u09cd\u09af\u09ac\u09be\u09a6|thanks|thank you|dhonnobad)(\s|$|[.!?,])/i,
    ];
  
    for (const p of greetingPatterns) {
      if (p.test(cleaned)) {
        result.type = "greeting";
        result.complexity = "simple";
        result.recommended_agents = ["code-guru"]; // Only 1 agent needed
        result.reason = "greeting_detected";
        return result;
      }
    }
  
    // ─── SIMPLE Q&A DETECTION ───
    const simpleQaPatterns = [
      /^\d+\s*[+\-*\/]\s*\d+/,
      /^(yes|no|ok|\u09a0\u09bf\u0995\s*\u0986\u099b\u09c7|\u09b9\u09cd\u09af\u09be\u0981|\u09a8\u09be)\s*$/i,
      /^(what\s*(is|are)\s+\w+\s*\w*\.?\s*\?*$)/i,
      /^(\u0995\u09c7\s+|\u0995\u09bf\s+|\u0995\u09cb\u09a5\u09be\u09af\u09bc\s+|\u0995\u0996\u09a8\s+|\u0995\u09c7\u09a8\s+)/i,
      /^(how\s+(many|much|far|long|old)\s+\w+\s*\?*$)/i,
      /^(\u09ac\u09be\u0982\u09b2\u09be\u09a6\u09c7\u09b6\u09c7\u09b0\s+(\u09b0\u09be\u099c\u09a7\u09be\u09a8\u09c0|\u09ae\u09c1\u09a6\u09cd\u09b0\u09be|\u09a7\u09b0\u09cd\u09ae|\u09ad\u09be\u09b7\u09be))/i,
      /capital\s+of\s+\w+/i,
    ];
  
    for (const p of simpleQaPatterns) {
      if (p.test(cleaned)) {
        result.type = "simple_qa";
        result.complexity = "simple";
        result.recommended_agents = ["code-guru", "qa-tyrant"]; // 2 agents enough
        result.reason = "simple_qa_detected";
        return result;
      }
    }
  
    // ─── WEB SEARCH NEED DETECTION ───
    // Detect queries that need real-time data (news, current events, factual lookups)
    const webSearchPatterns = [
      // Current events / news
      /latest|recent|today|this week|this month|this year|\u09b8\u09b0\u09cd\u09ac\u09b6\u09c7\u09b7|\u09b8\u09be\u09ae\u09cd\u09aa\u09cd\u09b0\u09a4\u09bf\u0995|\u0986\u099c|\u098f\u0987 \u09b8\u09aa\u09cd\u09a4\u09be\u09b9|\u098f\u0987 \u09ae\u09be\u09b8|\u098f\u0987 \u09ac\u099b\u09b0/i,
      /news|\u0996\u09ac\u09b0|\u09b8\u0982\u09ac\u09be\u09a6|heading|headlines/i,
      /what('s| is) (happening|going on|new)/i,
      // Factual lookups that may change
      /price|\u09a6\u09be\u09ae|cost|\u0996\u09b0\u099a|rate|exchange rate|\u09ac\u09bf\u09a8\u09bf\u09ae\u09af\u09bc \u09b9\u09be\u09b0/i,
      /population|\u099c\u09a8\u09b8\u0982\u0996\u09cd\u09af\u09be|GDP|economy|\u0985\u09b0\u09cd\u09a5\u09a8\u09c0\u09a4\u09bf/i,
      /weather|\u0986\u09ac\u09b9\u09be\u0993\u09af\u09bc\u09be|temperature|\u09a4\u09be\u09aa\u09ae\u09be\u09a4\u09cd\u09b0\u09be/i,
      // Technology updates
      /release|\u0986\u09aa\u09a1\u09c7\u099f|update.*version|new.*feature|changelog/i,
      /which\s+(company|platform|service)\s+( owns | runs | made)/i,
      // Questions about specific entities that may change
      /who\s+(is|was|are|were)\s+the\s+(current|new|president|ceo|pm|minister)/i,
      /\u0995\u09c7\s+(\u09b9\u09b2[\u09cb]?|\u0986\u099b\u09c7\u09a8?|\u099b\u09bf\u09b2\u09c7\u09a8?)\s+(\u09b0\u09be\u09b7\u09cd\u099f\u09cd\u09b0\u09aa\u09a4\u09bf|\u09aa\u09cd\u09b0\u09a7\u09be\u09a8\u09ae\u09a8\u09cd\u09a4\u09cd\u09b0\u09c0|\u09ae\u09a8\u09cd\u09a4\u09cd\u09b0\u09c0)/i,
      // Comparison that needs current data
      /best|top|\u09b8\u09c7\u09b0\u09be|\u09b6\u09c0\u09b0\u09cd\u09b7|compared?\s+to|\u09a4\u09c1\u09b2\u09a8\u09be/i,
    ];
  
    for (const p of webSearchPatterns) {
      if (p.test(cleaned)) {
        result.requires_web_search = true;
        break;
      }
    }
  
    // ─── PROJECT TASK DETECTION ───
    const projectPatterns = [
      /project|\u09aa\u09cd\u09b0\u099c\u09c7\u0995\u09cd\u099f|\u09aa\u09cd\u09b0\u0995\u09b2\u09cd\u09aa|\u0995\u09cb\u09a1|code|\u09ab\u09be\u0987\u09b2|file|directory|\u09a1\u09bf\u09b0\u09c7\u0995\u09cd\u099f\u09b0\u09bf/i,
      /analyze|analyse|\u09ac\u09bf\u09b6\u09cd\u09b2\u09c7\u09b7\u09a3|analysis/i,
      /technology|language|framework|tech\s+stack/i,
      /structure|architecture|\u0986\u09b0\u09cd\u0995\u09bf\u099f\u09c7\u0995\u099a\u09be\u09b0/i,
      /feature|feature|\u09ac\u09c8\u09b6\u09bf\u09b7\u09cd\u099f\u09cd\u09af/i,
    ];
  
    let projectScore = 0;
    for (const p of projectPatterns) {
      if (p.test(cleaned)) projectScore++;
    }
  
    if (
      projectScore >= 2 ||
      /^(analyze|\u09ac\u09bf\u09b6\u09cd\u09b2\u09c7\u09b7\u09a3|explain.*project|project.*(about|what))/.test(cleaned)
    ) {
      result.type = "project_task";
      result.complexity = "moderate";
      result.requires_code = true;
      result.requires_project_scan = true;
      result.recommended_agents = ["code-guru", "doc-king", "qa-tyrant"];
      result.reason = "project_task_detected";
      return result;
    }
  
    // ─── CODE CHANGE / DEBUG DETECTION ───
    const codeChangePatterns = [
      /fix|\u09a0\u09bf\u0995|solve|\u09b8\u09ae\u09be\u09a7\u09be\u09a8|bug|\u09ac\u09be\u0997|error|\u098f\u09b0\u09b0|\u09ad\u09c1\u09b2/i,
      /change|\u09aa\u09b0\u09bf\u09ac\u09b0\u09cd\u09a4\u09a8|add|\u09af\u09cb\u0997|remove|\u09ae\u09c1\u099b\u09c7|update|\u0986\u09aa\u09a1\u09c7\u099f/i,
      /implement|\u0987\u09ae\u09aa\u09cd\u09b2\u09bf\u09ae\u09c7\u09a8\u09cd\u099f|create|\u09a4\u09c8\u09b0\u09bf|build|\u09ac\u09be\u09a8\u09be\u0993/i,
      /function|\u09ab\u09be\u0982\u09b6\u09a8|method|\u09ae\u09c7\u09a5\u09a1|class|\u0995\u09cd\u09b2\u09be\u09b8|component/i,
      /api|endpoint|route|router/i,
      /database|db|\u09a1\u09be\u099f\u09be\u09ac\u09c7\u09b8|\u09a1\u09bf\u09ac\u09bf/i,
      /crash|crashes|hangs|freeze|\u09b2\u09cd\u09af\u09be\u0997/i,
      /performance|\u09aa\u09be\u09b0\u09ab\u09b0\u09ae\u09cd\u09af\u09be\u09a8\u09cd\u09b8|speed|\u0997\u09a4\u09bf|slow|\u09a7\u09c0\u09b0/i,
      /security|\u09a8\u09bf\u09b0\u09be\u09aa\u09a4\u09cd\u09a4\u09be|secure|\u09b8\u09c1\u09b0\u0995\u09cd\u09b7\u09bf\u09a4|vulnerability/i,
      /test|\u099f\u09c7\u09b8\u09cd\u099f|unit|integration|\u09aa\u09b0\u09c0\u0995\u09cd\u09b7\u09be/i,
    ];
  
    let codeScore = 0;
    for (const p of codeChangePatterns) {
      if (p.test(cleaned)) codeScore++;
    }
  
    if (
      codeScore >= 2 ||
      cleaned.includes("write code") ||
      cleaned.includes("code \u09b2\u09bf\u0996")
    ) {
      result.type = "code_change";
      result.complexity = codeScore >= 4 ? "complex" : "moderate";
      result.requires_code = true;
      result.requires_testing = true;
      result.requires_project_scan = true;
      result.recommended_agents = select(cleaned);
      // Ensure qa-tyrant is included for code changes (testing required)
      if (!result.recommended_agents.includes("qa-tyrant")) {
        result.recommended_agents.push("qa-tyrant");
      }
      result.reason = "code_change_detected";
      return result;
    }
  
    // ─── DEBUG DETECTION ───
    if (
      cleaned.includes("bug") ||
      cleaned.includes("error") ||
      cleaned.includes("\u09ad\u09c1\u09b2") ||
      cleaned.includes("\u0995\u09be\u099c \u0995\u09b0\u099b\u09c7 \u09a8\u09be") ||
      cleaned.includes("not working") ||
      cleaned.includes("crash") ||
      cleaned.includes("broken")
    ) {
      result.type = "debug_request";
      result.complexity = "moderate";
      result.requires_code = true;
      result.requires_testing = true;
      result.requires_project_scan = true;
      result.recommended_agents = ["bug-hunter", "code-guru", "qa-tyrant"];
      result.reason = "debug_request_detected";
      return result;
    }
  
    // ─── DEFAULT: MODERATE TASK ───
    if (cleaned.length > 50) {
      result.type = "task";
      result.complexity = "complex";
      result.recommended_agents = agents().map((a) => a.id); // All agents
      result.reason = "complex_task_default";
    } else {
      result.type = "simple_qa";
      result.complexity = "simple";
      result.recommended_agents = ["code-guru", "qa-tyrant"];
      result.reason = "short_input_default";
    }
  
    return result;
  }

  return classifyInput;
};

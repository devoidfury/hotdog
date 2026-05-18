// Tools module — exports all tools and the tool registry.

export * from "./registry.js";
export * from "./bash.js";
export * from "./write.js";
export * from "./read.js";
export * from "./edit.js";
export * from "./grep.js";
export * from "./find.js";
export * from "./fetch.js";
export * from "./question.js";
export * from "./pager.js";
export * from "./model.js";
export * from "./load_skill.js";

export * from "./project_info.js";
export * from "./review.js";
export * from "./explore.js";

// Import classes for factory use
import { BashTool } from "./bash.js";
import { WriteTool } from "./write.js";
import { ReadTool } from "./read.js";
import { EditTool } from "./edit.js";
import { GrepTool } from "./grep.js";
import { FindTool } from "./find.js";
import { FetchTool } from "./fetch.js";
import { QuestionTool } from "./question.js";
import { PagerTool } from "./pager.js";
import { ModelTool } from "./model.js";
import { LoadSkillTool } from "./load_skill.js";
import { ProjectInfoTool } from "./project_info.js";
import { ReviewTool } from "./review.js";
import { ExploreTool } from "./explore.js";

// Tool descriptors — declarative table of all core tools.
const TOOL_DESCRIPTORS = [
  { name: "bash", disabled: false },
  { name: "write", disabled: false },
  { name: "model", disabled: false },
  { name: "load_skill", disabled: false },
  { name: "read", disabled: false },
  { name: "question", disabled: false },
  { name: "pager", disabled: false },
  { name: "explore", disabled: false },
  { name: "find", disabled: false },
  { name: "grep", disabled: false },
  { name: "fetch", disabled: false },
  { name: "project_info", disabled: true },
  { name: "review", disabled: false },
  { name: "edit", disabled: false },
];

export const CORE_TOOL_NAMES = TOOL_DESCRIPTORS.map((d) => d.name);

// Import subagent tools
import {
  DelegateTaskTool,
  TaskStatusTool,
  TaskFollowupTool,
  TaskInterruptTool,
  PlanStatusTool,
  CompleteTaskTool,
} from "./subagents.js";

// Subagent tool names (manager-only)
export const SUBAGENT_TOOL_NAMES = [
  "delegate_task",
  "task_status",
  "task_followup",
  "task_interrupt",
  "plan_status",
  "complete_task",
];

/**
 * Create a tool factory that can create and register tools.
 */
export function createToolFactory(taskManager = null) {
  return {
    createTool(toolName, ctx, whitelist = null, managerToolsEnabled = false) {
      const descriptor = TOOL_DESCRIPTORS.find((d) => d.name === toolName);
      if (descriptor) {
        // Check disabled status
        if (
          descriptor.disabled &&
          !whitelist?.includes(toolName) &&
          !managerToolsEnabled
        ) {
          return null;
        }
        // Check whitelist
        if (whitelist && !whitelist.includes(toolName)) {
          return null;
        }
      }

      // Core tools
      switch (toolName) {
        case "bash":
          return new BashTool();
        case "write":
          return new WriteTool();
        case "read":
          return new ReadTool();
        case "edit":
          return new EditTool();
        case "grep":
          return new GrepTool();
        case "find":
          return new FindTool();
        case "fetch":
          return new FetchTool();
        case "question":
          return new QuestionTool();
        case "pager":
          return new PagerTool();
        case "explore":
          return new ExploreTool();
        case "model":
          return new ModelTool(ctx?.modelRegistry || {});
        case "load_skill":
          return new LoadSkillTool();
        case "project_info":
          return new ProjectInfoTool();
        case "review":
          return new ReviewTool();
      }

      // Subagent tools (manager-only)
      if (managerToolsEnabled && taskManager) {
        switch (toolName) {
          case "delegate_task":
            return new DelegateTaskTool(taskManager);
          case "task_status":
            return new TaskStatusTool(taskManager);
          case "task_followup":
            return new TaskFollowupTool(taskManager);
          case "task_interrupt":
            return new TaskInterruptTool(taskManager);
          case "plan_status":
            return new PlanStatusTool(taskManager);
          case "complete_task":
            return new CompleteTaskTool(taskManager);
        }
      }

      return null;
    },

    async createAndRegister(
      toolName,
      registry,
      ctx,
      whitelist = null,
      managerToolsEnabled = false,
    ) {
      const tool = this.createTool(
        toolName,
        ctx,
        whitelist,
        managerToolsEnabled,
      );
      if (tool) {
        registry.register(toolName, tool);
      }
    },
  };
}

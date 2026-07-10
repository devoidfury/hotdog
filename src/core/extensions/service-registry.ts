// Service Registry — maps abstract interface names to implementations.

import { logger } from "../logger.ts";
import { ExtensionError } from "../error.ts";

/**
 * Registry for abstract service implementations.
 */
export class ServiceRegistry {
  #services: Map<string, unknown> = new Map();

  /**
   * Register an implementation for an abstract service.
   */
  register(name: string, implementation: unknown): void {
    if (this.#services.has(name)) {
      logger.warn(
        `[services] "${name}" already registered — replacing with new implementation.`,
      );
    }
    this.#services.set(name, implementation);
  }

  /**
   * Get a registered service implementation.
   */
  get(name: string): unknown {
    const impl = this.#services.get(name);
    if (impl === undefined) {
      throw new ExtensionError(
        `Service "${name}" is not registered. ` +
          `Ensure a provider extension is loaded and its create() has registered this service.`,
      );
    }
    return impl;
  }

  has(name: string): boolean {
    return this.#services.has(name);
  }

  names(): string[] {
    return Array.from(this.#services.keys());
  }

  /**
   * Verify that a registered implementation satisfies a contract.
   */
  checkContract(
    name: string,
    expectedMethods: string[],
  ): { valid: boolean; missing: string[] } {
    const impl = this.#services.get(name);
    if (!impl) {
      return { valid: false, missing: expectedMethods };
    }
    const missing = expectedMethods.filter(
      (m) => typeof (impl as Record<string, unknown>)[m] !== "function",
    );
    return { valid: missing.length === 0, missing };
  }
}

/**
 * Create a new ServiceRegistry instance.
 */
export function createServiceRegistry(): ServiceRegistry {
  return new ServiceRegistry();
}

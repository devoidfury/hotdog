// Service Registry — maps abstract interface names to implementations.

import { logger } from "../logger.ts";
import { ExtensionError } from "../error.ts";

/**
 * Registry for abstract service implementations.
 *
 * Typed via a "service contract map" — an interface mapping service names
 * to their expected types. Example:
 *
 *   interface MyServices {
 *     "ui.renderer": { render(text: string): void };
 *     "storage": { get(key: string): unknown; set(key: string, value: unknown): void };
 *   }
 *
 *   const registry = new ServiceRegistry<MyServices>();
 *   const renderer = registry.get("ui.renderer"); // typed as { render(text: string): void }
 */
export class ServiceRegistry<T extends Record<string, unknown> = Record<string, unknown>> {
  #services: Map<keyof T, T[keyof T]> = new Map();

  /**
   * Register an implementation for an abstract service.
   * @param name - Service name (must be a key in T).
   * @param implementation - Implementation satisfying the service contract.
   */
  register<K extends keyof T>(name: K, implementation: T[K]): void {
    if (this.#services.has(name)) {
      logger.warn(
        `[services] "${String(name)}" already registered — replacing with new implementation.`,
      );
    }
    this.#services.set(name, implementation);
  }

  /**
   * Get a registered service implementation.
   * @param name - Service name.
   * @returns The implementation, typed according to T.
   */
  get<K extends keyof T>(name: K): T[K] {
    const impl = this.#services.get(name);
    if (impl === undefined) {
      throw new ExtensionError(
        `Service "${String(name)}" is not registered. ` +
          `Ensure a provider extension is loaded and its create() has registered this service.`,
      );
    }
    return impl as T[K];
  }

  has(name: string): boolean {
    return this.#services.has(name as keyof T);
  }

  names(): (keyof T & string)[] {
    return Array.from(this.#services.keys()) as (keyof T & string)[];
  }

  /**
   * Verify that a registered implementation satisfies a contract.
   */
  checkContract(
    name: string,
    expectedMethods: string[],
  ): { valid: boolean; missing: string[] } {
    const impl = this.#services.get(name as keyof T);
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

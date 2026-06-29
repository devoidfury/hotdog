// Service Registry — maps abstract interface names to implementations.
// Extensions declare what services they provide (via extension.json "services" field)
// and what services they require (via "requires"). At runtime, extensions access
// implementations via core.service(name).
//
// This enables swappable dependencies — swap "session" for a different implementation
// without changing any extension that depends on it.

import { logger } from "../logger.js";
import { ExtensionError } from "../error.js";

/**
 * Registry for abstract service implementations.
 *
 * Services are registered programmatically by extensions during create().
 * The contract (expected methods) is declared statically in extension.json
 * so the loader can validate ordering and detect missing dependencies at startup.
 */
export class ServiceRegistry {
  /** @type {Map<string, any>} name → implementation */
  #services = new Map();

  /**
   * Register an implementation for an abstract service.
   *
   * @param {string} name - Abstract service name (e.g. "session", "resourceLoader").
   * @param {any} implementation - The service implementation (object, function, etc.).
   */
  register(name, implementation) {
    if (this.#services.has(name)) {
      logger.warn(
        `[services] "${name}" already registered — replacing with new implementation.`,
      );
    }
    this.#services.set(name, implementation);
  }

  /**
   * Get a registered service implementation.
   *
   * @param {string} name - Abstract service name.
   * @returns {any} The registered implementation.
   * @throws {Error} If the service is not registered.
   */
  get(name) {
    const impl = this.#services.get(name);
    if (impl === undefined) {
      throw new ExtensionError(
        `Service "${name}" is not registered. ` +
        `Ensure a provider extension is loaded and its create() has registered this service.`,
      );
    }
    return impl;
  }

  /**
   * Check if a service is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.#services.has(name);
  }

  /**
   * Get all registered service names.
   * @returns {string[]}
   */
  names() {
    return Array.from(this.#services.keys());
  }

  /**
   * Verify that a registered implementation satisfies a contract.
   * Checks that all expected method names exist on the implementation.
   *
   * @param {string} name - Service name.
   * @param {string[]} expectedMethods - Array of method names.
   * @returns {{ valid: boolean, missing: string[] }}
   */
  checkContract(name, expectedMethods) {
    const impl = this.#services.get(name);
    if (!impl) {
      return { valid: false, missing: expectedMethods };
    }
    const missing = expectedMethods.filter((m) => typeof impl[m] !== "function");
    return { valid: missing.length === 0, missing };
  }
}

/**
 * Create a new ServiceRegistry instance.
 * @returns {ServiceRegistry}
 */
export function createServiceRegistry() {
  return new ServiceRegistry();
}

'use strict';

const { CircuitBreaker, CircuitBreakerRegistry, State } = require('../../lib/circuit-breaker');

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('basic operations', () => {
    it('should start in CLOSED state', () => {
      const cb = new CircuitBreaker('test');
      expect(cb.getState().state).toBe(State.CLOSED);
    });

    it('should execute successful function', async () => {
      const cb = new CircuitBreaker('test');
      const fn = jest.fn().mockResolvedValue('success');

      const result = await cb.execute(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should count failures', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 3 });
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(cb.execute(fn)).rejects.toThrow('fail');
      await expect(cb.execute(fn)).rejects.toThrow('fail');

      expect(cb.getState().failureCount).toBe(2);
    });

    it('should open circuit after threshold', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 2 });
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(cb.execute(fn)).rejects.toThrow('fail');
      await expect(cb.execute(fn)).rejects.toThrow('fail');

      expect(cb.getState().state).toBe(State.OPEN);
    });

    it('should reject when circuit is open', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 1 });
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(cb.execute(fn)).rejects.toThrow('fail');
      await expect(cb.execute(() => Promise.resolve('success'))).rejects.toThrow('Circuit breaker is OPEN');
    });
  });

  describe('HALF_OPEN state', () => {
    it('should transition to HALF_OPEN after reset timeout', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        resetTimeout: 100,
        successThreshold: 1,
      });

      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(cb.getState().state).toBe(State.OPEN);

      await new Promise(r => setTimeout(r, 150));

      // 下一次执行应该进入 HALF_OPEN
      const successFn = jest.fn().mockResolvedValue('success');
      await cb.execute(successFn);

      expect(cb.getState().state).toBe(State.CLOSED);
    });
  });

  describe('reset', () => {
    it('should reset circuit to CLOSED', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 1 });
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      cb.reset();

      expect(cb.getState().state).toBe(State.CLOSED);
      expect(cb.getState().failureCount).toBe(0);
    });
  });
});

describe('CircuitBreakerRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new CircuitBreakerRegistry();
  });

  it('should create and retrieve circuit breakers', () => {
    const cb = registry.get('test-service');
    expect(cb).toBeInstanceOf(CircuitBreaker);
    expect(registry.get('test-service')).toBe(cb); // 应该返回同一个实例
  });

  it('should return all states', () => {
    registry.get('service1');
    registry.get('service2');

    const states = registry.getAllStates();
    expect(Object.keys(states)).toHaveLength(2);
    expect(states.service1).toBeDefined();
    expect(states.service2).toBeDefined();
  });

  it('should reset specific circuit breaker', () => {
    const cb = registry.get('test');
    cb.failureCount = 5;

    registry.reset('test');

    expect(cb.getState().failureCount).toBe(0);
  });

  it('should reset all circuit breakers', () => {
    const cb1 = registry.get('service1');
    const cb2 = registry.get('service2');
    cb1.failureCount = 5;
    cb2.failureCount = 3;

    registry.resetAll();

    expect(cb1.getState().failureCount).toBe(0);
    expect(cb2.getState().failureCount).toBe(0);
  });
});

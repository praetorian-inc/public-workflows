# Refactoring Anti-Patterns

Part of the [Refactoring Patterns](refactoring-patterns.md) reference — when refactoring hurts more than it helps.

## Anti-Patterns

### ❌ Don't Extract Trivially

**Bad**:

```typescript
function isPositive(x: number): boolean {
  return x > 0;
}

function calculate(x: number) {
  if (isPositive(x)) {
    // Complexity 1, but harder to read
    return x * 2;
  }
  return 0;
}
```

**Good**:

```typescript
function calculate(x: number) {
  if (x > 0) {
    // Complexity 1, clearer
    return x * 2;
  }
  return 0;
}
```

### ❌ Don't Over-Nest Functions

**Bad**: Extracting causes harder-to-follow call chains

**Good**: Extract only when it improves clarity

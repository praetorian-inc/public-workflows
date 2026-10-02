# More Refactoring Patterns

Part of the [Refactoring Patterns](refactoring-patterns.md) reference (Patterns 5–7).

## Pattern 5: Lookup Tables (Replace Switch)

**When to use**: Switch statements with simple value mappings

**Complexity reduction**: High (eliminates all case branches)

### Before (Complexity: 6)

```go
func GetStatusColor(status string) string {
    switch status {
    case "active":
        return "green"
    case "pending":
        return "yellow"
    case "failed":
        return "red"
    case "disabled":
        return "gray"
    case "archived":
        return "blue"
    default:
        return "black"
    }
}
```

### After (Complexity: 1)

```go
var statusColors = map[string]string{
    "active":   "green",
    "pending":  "yellow",
    "failed":   "red",
    "disabled": "gray",
    "archived": "blue",
}

func GetStatusColor(status string) string {
    if color, ok := statusColors[status]; ok {
        return color
    }
    return "black" // default
}
```

**Benefits:**

- No conditional logic
- Easy to extend (add to map)
- Can load from configuration
- Zero complexity

---

## Pattern 6: Decompose Conditional

**When to use**: Complex conditional expressions

**Complexity reduction**: Medium (extracts to named functions)

### Before (Complexity: 5)

```typescript
function shouldSendReminder(user: User, task: Task): boolean {
  if (
    user.preferences.reminders &&
    task.dueDate &&
    task.dueDate.getTime() - Date.now() < 24 * 60 * 60 * 1000 &&
    !task.completed &&
    task.assignee?.id === user.id
  ) {
    return true;
  }
  return false;
}
```

### After (Complexity: 5, but clearer)

```typescript
function shouldSendReminder(user: User, task: Task): boolean {
  return (
    hasRemindersEnabled(user) && isDueSoon(task) && isIncomplete(task) && isAssignedTo(task, user)
  );
}

function hasRemindersEnabled(user: User): boolean {
  return user.preferences.reminders === true;
}

function isDueSoon(task: Task): boolean {
  if (!task.dueDate) return false;
  const oneDayMs = 24 * 60 * 60 * 1000;
  return task.dueDate.getTime() - Date.now() < oneDayMs;
}

function isIncomplete(task: Task): boolean {
  return !task.completed;
}

function isAssignedTo(task: Task, user: User): boolean {
  return task.assignee?.id === user.id;
}
```

**Benefits:**

- Intention-revealing function names
- Each predicate testable independently
- Easier to modify conditions
- Self-documenting code

---

## Pattern 7: Replace Nested Conditionals with Polymorphism

**When to use**: Type checking with nested conditionals

**Complexity reduction**: High (eliminates type checks)

### Before (Complexity: 8)

```typescript
function processPayment(payment: Payment): void {
  if (payment.method === "credit-card") {
    if (payment.cardType === "visa") {
      processVisaPayment(payment);
    } else if (payment.cardType === "mastercard") {
      processMastercardPayment(payment);
    }
  } else if (payment.method === "paypal") {
    if (payment.account.verified) {
      processPayPalPayment(payment);
    } else {
      throw new Error("Unverified PayPal");
    }
  } else if (payment.method === "bank-transfer") {
    processBankTransfer(payment);
  }
}
```

### After (Complexity: 1 per class, 2 for factory)

```typescript
interface PaymentProcessor {
  process(payment: Payment): void;
}

class CreditCardProcessor implements PaymentProcessor {
  process(payment: Payment): void {
    if (payment.cardType === "visa") {
      processVisaPayment(payment);
    } else if (payment.cardType === "mastercard") {
      processMastercardPayment(payment);
    }
  }
}

class PayPalProcessor implements PaymentProcessor {
  process(payment: Payment): void {
    if (!payment.account.verified) {
      throw new Error("Unverified PayPal");
    }
    processPayPalPayment(payment);
  }
}

class BankTransferProcessor implements PaymentProcessor {
  process(payment: Payment): void {
    processBankTransfer(payment);
  }
}

const processors: Record<string, PaymentProcessor> = {
  "credit-card": new CreditCardProcessor(),
  paypal: new PayPalProcessor(),
  "bank-transfer": new BankTransferProcessor(),
};

function processPayment(payment: Payment): void {
  const processor = processors[payment.method];
  if (!processor) {
    throw new Error(`Unknown payment method: ${payment.method}`);
  }
  processor.process(payment);
}
```

**Benefits:**

- Each processor handles own complexity
- Easy to add new payment methods
- Testable in isolation
- Follows Single Responsibility Principle

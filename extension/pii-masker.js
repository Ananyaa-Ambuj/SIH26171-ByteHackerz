class PIIMasker {
  constructor() {
    this.vault = new Map();        // Real Value -> Fake Value
    this.reverseVault = new Map(); // Fake Value -> Real Value
    this.counter = 1;
  }

  // Generate consistent fake values based on entity category
  getFakeValue(realValue, type = 'text') {
    if (this.vault.has(realValue)) {
      return this.vault.get(realValue);
    }

    let fakeValue = '';
    const id = this.counter++;

    switch (type.toLowerCase()) {
      case 'name':
        fakeValue = `User_${id}`;
        break;
      case 'email':
        fakeValue = `user_${id}@example.com`;
        break;
      case 'phone':
        fakeValue = `+1-555-010${id % 10}`;
        break;
      case 'address':
        fakeValue = `${100 + id} Sample St`;
        break;
      default:
        fakeValue = `[MOCKED_${id}]`;
    }

    this.vault.set(realValue, fakeValue);
    this.reverseVault.set(fakeValue, realValue);
    return fakeValue;
  }

  // Replace synthetic values in AI response back with original values
  unmaskText(aiResponseText) {
    let unmasked = aiResponseText;
    for (const [fake, real] of this.reverseVault.entries()) {
      unmasked = unmasked.replaceAll(fake, real);
    }
    return unmasked;
  }
}

// Export for usage in ES modules / offscreen environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PIIMasker;
}

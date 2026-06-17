// Updated to include new handlers
// ... existing code

import { setupShop } from './handlers/shop';
import { setupCrypto } from './handlers/crypto';

// In main bot setup:
setupShop(bot);
setupCrypto(bot);

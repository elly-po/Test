import { decodePumpfun } from './pumpfunDecoder.js';

const signature = 'YOUR_REAL_SIGNATURE_HERE';

decodePumpfun(signature)
  .then(data => {
    console.log('Decoded Data:', data);
  })
  .catch(err => {
    console.error('Error:', err.message);
  });

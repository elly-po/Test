/*import { decodePumpfun } from './pumpfunDecoder.js';

const signature = '5g6xXeyvBk526k1tvZENcrsJJ6HffgyunfgTcouixmHYQtZzgaSXAGVeoSiENVHMJPUSBxCftruwsZiwozbmsQfd';

decodePumpfun(signature)
  .then(data => {
    console.log('Decoded Data:', data);
  })
  .catch(err => {
    console.error('Error:', err.message);
  });*/

import { decodeRaydium } from './raydiumDecoder.js';

const signature = 'INSERT_RAYDIUM_TX_SIGNATURE_HERE';

decodeRaydium(signature)
  .then(data => {
    console.log('Decoded Raydium Data:', data);
  })
  .catch(err => {
    console.error('Raydium Decode Error:', err.message);
  });

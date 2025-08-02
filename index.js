/*import { decodePumpfun } from './pumpfunDecoder.js';

const signature = '5g6xXeyvBk526k1tvZENcrsJJ6HffgyunfgTcouixmHYQtZzgaSXAGVeoSiENVHMJPUSBxCftruwsZiwozbmsQfd';

decodePumpfun(signature)
  .then(data => {
    console.log('Decoded Data:', data);
  })
  .catch(err => {
    console.error('Error:', err.message);
  });*/
/*
import { decodeRaydium } from './raydiumDecoder.js';

const signature = '5zDhqpXjMDmSP3jSaR4rhetamwXUMX4v1uH791EFKpqLAkooc3mQUvmENETPggyMmcd1c8NhmVFNS8oFRkBMTodM';

decodeRaydium(signature)
  .then(data => {
    console.log('Decoded Raydium Data:', data);
  })
  .catch(err => {
    console.error('Raydium Decode Error:', err.message);
  });*/

import { decodeMeteora } from './meteoraDecoder.js';

const signature = '3NtHRzJMsbsbVESaZctrGEtkzGaPDQqNhFyLfzBnAvk7Buaw5ZUkDnbAN7cCPBdojw2mYfESWxYwwcw1a9yAyxRD';

decodeMeteora(signature)
  .then(data => console.log('Decoded Meteora Data:', data))
  .catch(err => console.error('Meteora Decode Error:', err.message));

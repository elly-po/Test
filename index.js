import { decodePumpfun } from './pumpfunDecoder.js';

const signature = '2rSr9skWgMzXPB1LxuufvM6DakPeSuTobNvUv1eT53rr4up9LhwqBT7EECW4mc8sw7BKyuQ73UMV7aHzqiaRDRG5';

decodePumpfun(signature)
  .then(data => {
    console.log('Decoded Data:', data);
  })
  .catch(err => {
    console.error('Error:', err.message);
  });

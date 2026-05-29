use pqcrypto_ml_dsa::ml_dsa_65;
use zeroize::{Zeroize, ZeroizeOnDrop};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct PQCIdentityVault {
    public_key: Vec<u8>,
    #[zeroize(drop)] // Ensure private key bytes are explicitly wiped on drop
    secret_key: Vec<u8>,
}

#[wasm_bindgen]
impl PQCIdentityVault {
    // Derive deterministic keypair from a secure 32-byte seed
    pub fn from_seed(seed: &[u8]) -> Self {
        // Correct pqcrypto-ml-dsa seed mapping (FIPS 204 keys generation)
        let (pk, sk) = ml_dsa_65::keypair_from_seed(seed);
        Self {
            public_key: pk.as_bytes().to_vec(),
            secret_key: sk.as_bytes().to_vec(),
        }
    }

    pub fn get_public_key(&self) -> Vec<u8> {
        self.public_key.clone()
    }

    pub fn sign_message(&self, message: &[u8]) -> Vec<u8> {
        // Detached signature generation trapped securely inside WASM linear memory
        let keypair_sk = ml_dsa_65::SecretKey::from_bytes(&self.secret_key).unwrap();
        let signature = ml_dsa_65::detached_sign(message, &keypair_sk);
        signature.as_bytes().to_vec()
    }
}

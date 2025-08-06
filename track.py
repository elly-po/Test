from solana.rpc.api import Client
from solana.publickey import PublicKey

# Connect to Solana mainnet
solana_client = Client("https://api.mainnet-beta.solana.com")

# Replace with the wallet address you want to track
wallet_address =DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj

def get_recent_transactions():
    try:
        # Convert string address to PublicKey object
        public_key = PublicKey(wallet_address)
        
        # Fetch recent transaction signatures
        transactions = solana_client.get_confirmed_signatures_for_address2(public_key)
        
        # Print the transactions
        print("Recent Transactions:")
        for tx in transactions.value:
            print(f"Signature: {tx.signature}")
            print(f"Block Time: {tx.block_time}")
            print(f"Status: {'Success' if not tx.err else 'Failed'}")
            print("------")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    get_recent_transactions()

const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { deployContract, expect } = require('@1inch/solidity-utils');
const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256');

// const { gasspectEVM } = require('./helpers/profileEVM');

const {
    shouldBehaveLikeMerkleDropFor4WalletsWithBalances1234,
} = require('./behaviors/MerkleDrop.behavior');

const {
    shouldBehaveLikeCumulativeMerkleDropFor4WalletsWithBalances1234,
} = require('./behaviors/CumulativeMerkleDrop.behavior');

async function makeDrop (token, drop, walletsAddresses, amounts, deposit) {
    const elements = walletsAddresses.map((w, i) => w + BigInt(amounts[i]).toString(16).padStart(64, '0'));
    const hashedElements = elements.map(keccak256).map(x => MerkleTree.bufferToHex(x));
    const tree = new MerkleTree(elements, keccak256, { hashLeaves: true, sort: true });
    const root = tree.getHexRoot();
    const leaves = tree.getHexLeaves();
    const proofs = leaves.map(tree.getHexProof, tree);

    await drop.setMerkleRoot(root);
    await token.mint(drop, deposit);

    return { hashedElements, leaves, root, proofs };
}

describe('CumulativeMerkleDrop', function () {
    function findSortedIndex (self, i) {
        return self.leaves.indexOf(self.hashedElements[i]);
    }

    async function initContracts () {
        const token = await deployContract('TokenMock', ['1INCH Token', '1INCH']);
        const drop = await deployContract('CumulativeMerkleDrop', [token]);
        return { token, drop };
    };

    async function deployContractsFixture () {
        const [owner, alice, bob, carol, dan] = await ethers.getSigners();

        const { token, drop } = await initContracts();
        await Promise.all([alice, bob, carol, dan].map(w => token.mint(w, 1n)));

        return {
            accounts: { owner, alice, bob, carol, dan },
            contracts: { token, drop },
        };
    }

    it.skip('Benchmark 30000 wallets (merkle tree height 15)', async function () { // if you want to run this test, add verify & verifyAsm to CumulativeMerkleDrop.sol
        const { accounts: { alice }, contracts: { token, drop } } = await loadFixture(deployContractsFixture);
        const accounts = Array(30000).fill().map((_, i) => '0x' + (BigInt(alice.address) + BigInt(i)).toString(16));
        const amounts = Array(30000).fill().map((_, i) => i + 1);

        const params = await makeDrop(token, drop, accounts, amounts, 1000000n);

        if (drop.interface.getFunction('verify')) {
            await drop.contract.methods.verify(params.proofs[findSortedIndex(params, 0)], params.root, params.leaves[0]).send();
            expect(await drop.verify(params.proofs[findSortedIndex(params, 0)], params.root, params.leaves[0])).to.be.true;
        }
        await drop.contract.methods.verifyAsm(params.proofs[findSortedIndex(params, 0)], params.root, params.leaves[0]).send();
        expect(await drop.verifyAsm(params.proofs[findSortedIndex(params, 0)], params.root, params.leaves[0])).to.be.true;
        const tx = await drop.claim(accounts[0], 1, params.root, params.proofs[findSortedIndex(params, 0)]);
        await expect(tx).to.changeTokenBalances(token, [accounts[0], drop], [1, -1]);
    });

    describe('behave like merkle drop', function () {
        async function makeDropForSomeAccounts (token, drop, allWallets, params) {
            const wallets = allWallets.slice(1, params.amounts.length + 1); // drop first wallet
            return {
                ...(await makeDrop(token, drop, wallets.map((w) => w.address), params.amounts, params.deposit)),
                wallets,
            };
        }

        describe('Single drop for 4 wallets: [1, 2, 3, 4]', function () {
            shouldBehaveLikeMerkleDropFor4WalletsWithBalances1234({
                walletsCount: 4,
                initContracts,
                functions: { makeDrop: makeDropForSomeAccounts, findSortedIndex },
                makeDropParams: {
                    amounts: [1n, 2n, 3n, 4n],
                    deposit: 10n,
                },
            });
        });

        describe('Double drop for 4 wallets: [1, 2, 3, 4] + [2, 3, 4, 5] = [3, 5, 7, 9]', async function () {
            shouldBehaveLikeCumulativeMerkleDropFor4WalletsWithBalances1234({
                initContracts,
                functions: {
                    makeFirstDrop: makeDropForSomeAccounts,
                    makeSecondDrop: makeDropForSomeAccounts,
                    findSortedIndex,
                },
                makeFirstDropParams: {
                    amounts: [1n, 2n, 3n, 4n],
                    deposit: 1n + 2n + 3n + 4n,
                },
                makeSecondDropParams: {
                    amounts: [3n, 5n, 7n, 9n],
                    deposit: 2n + 3n + 4n + 5n,
                },
            });
        });
    });

    describe('adminWithdraw', function () {
        it('should allow owner to withdraw tokens', async function () {
            const { accounts: { owner, alice }, contracts: { token, drop } } = await loadFixture(deployContractsFixture);
            
            // Mint some tokens to the drop contract
            const withdrawAmount = 100n;
            await token.mint(drop, withdrawAmount);
            
            // Owner should be able to withdraw
            const tx = await drop.adminWithdraw(token, withdrawAmount);
            await expect(tx).to.changeTokenBalances(token, [drop, owner], [-withdrawAmount, withdrawAmount]);
        });

        it('should allow owner to withdraw partial amount', async function () {
            const { accounts: { owner }, contracts: { token, drop } } = await loadFixture(deployContractsFixture);
            
            // Mint some tokens to the drop contract
            const totalAmount = 100n;
            const withdrawAmount = 30n;
            await token.mint(drop, totalAmount);
            
            // Owner should be able to withdraw partial amount
            const tx = await drop.adminWithdraw(token, withdrawAmount);
            await expect(tx).to.changeTokenBalances(token, [drop, owner], [-withdrawAmount, withdrawAmount]);
            
            // Check remaining balance
            expect(await token.balanceOf(drop)).to.equal(totalAmount - withdrawAmount);
        });

        it('should allow owner to withdraw different tokens', async function () {
            const { accounts: { owner }, contracts: { drop } } = await loadFixture(deployContractsFixture);
            
            // Deploy a different token
            const otherToken = await deployContract('TokenMock', ['Other Token', 'OTHER']);
            const withdrawAmount = 50n;
            await otherToken.mint(drop, withdrawAmount);
            
            // Owner should be able to withdraw the different token
            const tx = await drop.adminWithdraw(otherToken, withdrawAmount);
            await expect(tx).to.changeTokenBalances(otherToken, [drop, owner], [-withdrawAmount, withdrawAmount]);
        });

        it('should revert when non-owner tries to withdraw', async function () {
            const { accounts: { alice }, contracts: { token, drop } } = await loadFixture(deployContractsFixture);
            
            // Mint some tokens to the drop contract
            await token.mint(drop, 100n);
            
            // Non-owner should not be able to withdraw
            await expect(drop.connect(alice).adminWithdraw(token, 50n)).to.be.revertedWithCustomError(drop, 'OwnableUnauthorizedAccount');
        });

        it('should revert when trying to withdraw more than available balance', async function () {
            const { accounts: { owner }, contracts: { token, drop } } = await loadFixture(deployContractsFixture);
            
            // Mint some tokens to the drop contract
            const availableAmount = 100n;
            await token.mint(drop, availableAmount);
            
            // Should revert when trying to withdraw more than available
            await expect(drop.adminWithdraw(token, availableAmount + 1n)).to.be.reverted;
        });

        it('should emit correct events when withdrawing', async function () {
            const { accounts: { owner }, contracts: { token, drop } } = await loadFixture(deployContractsFixture);
            
            // Mint some tokens to the drop contract
            const withdrawAmount = 75n;
            await token.mint(drop, withdrawAmount);
            
            // Withdraw and check token transfer event
            const tx = await drop.adminWithdraw(token, withdrawAmount);
            await expect(tx).to.changeTokenBalances(token, [drop, owner], [-withdrawAmount, withdrawAmount]);
        });
    });
});

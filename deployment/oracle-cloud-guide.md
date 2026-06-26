# Oracle Cloud Free Tier - Instance Creation Guide

## Step 1: Create Account
- Go to https://cloud.oracle.com
- Sign up for a free account (requires credit card but won't charge)
- Select your home region (closest to you for low latency)

## Step 2: Create Compute Instance

1. Go to **Compute > Instances > Create Instance**
2. Configure:
   - **Name:** whatsapp-crm
   - **Image:** Ubuntu 22.04 (Canonical)
   - **Shape:** Click "Change Shape"
     - Select **Ampere** (ARM processor)
     - Choose **VM.Standard.A1.Flex**
     - OCPUs: **2** (you get up to 4 free)
     - Memory: **12 GB** (you get up to 24 free)
   - **Networking:** Create new VCN or use existing
   - **SSH Keys:** Generate or upload your public key
3. Click **Create**

## Step 3: Open Firewall Ports

1. Go to **Networking > Virtual Cloud Networks > your VCN**
2. Click on the **subnet** > **Security List**
3. Add **Ingress Rules**:
   - Source: 0.0.0.0/0, Protocol: TCP, Dest Port: **80**
   - Source: 0.0.0.0/0, Protocol: TCP, Dest Port: **443**

## Step 4: Connect via SSH

```bash
ssh -i ~/path/to/your-key.key ubuntu@<your-instance-public-ip>
```

## Step 5: Run Setup

```bash
# Upload setup script or clone repo first
git clone <your-repo-url> /home/ubuntu/whatsapp-crm
cd /home/ubuntu/whatsapp-crm/deployment
sudo chmod +x setup-server.sh
sudo ./setup-server.sh
```

## Important Notes

- The **Always Free** ARM instances may show "Out of capacity" in some regions.
  If this happens, try:
  - A different availability domain
  - A different region
  - Try at off-peak hours (early morning)
  - Reduce to 1 OCPU / 6GB RAM
- Once created, the instance stays free forever (no time limit)
- Your instance gets a public IP automatically
- Oracle won't charge you as long as you stay within free tier limits

## Free Tier Limits (Always Free):
- 4 ARM OCPUs total
- 24 GB RAM total
- 200 GB block storage
- 10 TB outbound data/month

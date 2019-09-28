import * as ip from 'internal-ip';

export async function get_ip() : Promise<string> {
    return ip.v4();
}
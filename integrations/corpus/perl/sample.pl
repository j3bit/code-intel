use strict;
use warnings;

sub greet {
    my ($name) = @_;
    return "hello $name";
}

print greet('world'), "\n";
